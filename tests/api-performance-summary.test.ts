import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("API performance summary CLI", () => {
  it("groups JSON lines by action without exposing request identifiers", () => {
    const input = [
      { kind: "api.performance", action: "task.get", requestId: "secret-1", payload: { title: "PRIVATE_VALUE" }, ok: true, durationMs: 10, documentReads: 2, documentWrites: 0, queries: 1, responseBytes: 20, databaseOperations: { schedule_segments: { query: 2 }, reminder_preferences: { documentRead: 1 }, tenant_PRIVATE_VALUE: { query: 999 } } },
      { kind: "api.performance", action: "task.get", requestId: "secret-2", ok: false, durationMs: 30, documentReads: 1, documentWrites: 1, queries: 0, responseBytes: 10, databaseOperations: { schedule_segments: { query: 3 }, reminder_preferences: { documentRead: 2 }, tasks: { unknown_PRIVATE_VALUE: 999 } } },
      { kind: "other", action: "ignored", requestId: "secret-3" }
    ].map(value => JSON.stringify(value)).join("\n");
    const output = execFileSync(process.execPath, ["tools/summarize-api-performance.mjs"], { cwd: process.cwd(), input, encoding: "utf8" });
    expect(JSON.parse(output)).toEqual([expect.objectContaining({ action: "task.get", calls: 2, errors: 1, documentReads: 3, documentWrites: 1, queries: 1, responseBytes: 30, durationP50Ms: 10, durationP95Ms: 30, databaseOperations: expect.objectContaining({ schedule_segments: { documentRead: 0, documentWrite: 0, query: 5 }, reminder_preferences: { documentRead: 3, documentWrite: 0, query: 0 } }) })]);
    expect(output).not.toContain("secret-");
    expect(output).not.toContain("requestId");
    expect(output).not.toContain("PRIVATE_VALUE");
    expect(output).not.toContain("tenant_");
    expect(output).not.toContain("unknown_");
  });

  it("joins logical operations offline and deduplicates shared physical requests globally", () => {
    const client = (operationId: string, action: string, requests: {requestId:string;reusedInFlight:boolean}[], extra: Record<string, unknown> = {}) => ({
      kind:"client.logical-list",schemaVersion:1,operationId,childOperationIds:[],action,
      source:"full",result:"success",complete:true,error:"none",attempts:requests.length,pages:1,
      emptyContinuationPages:0,continuationPages:0,restarts:0,itemCount:1,memberCount:0,rpcCumulativeMs:10,wallClockMs:10,
      requestLinksComplete:true,droppedRequestLinks:0,requests,payload:{title:"PRIVATE_CANARY"},...extra,
    });
    const input = [
      client("operation-one","task.list",[{requestId:"shared-request",reusedInFlight:false},{requestId:"missing-request",reusedInFlight:false}]),
      client("operation-two","task.list",[{requestId:"shared-request",reusedInFlight:true}]),
      client("operation-three","progress.get",[{requestId:"progress-missing",reusedInFlight:false}],{requestLinksComplete:false,droppedRequestLinks:3,complete:false,result:"cancelled"}),
      client("operation-private","PRIVATE_CANARY",[]),
      {kind:"api.performance",action:"task.list",requestId:"shared-request",durationMs:11,ok:true},
      {kind:"api.performance",action:"reminder.list",requestId:"missing-request",durationMs:99,ok:true},
    ].map(value=>JSON.stringify(value)).join("\n");
    const output = execFileSync(process.execPath,["tools/summarize-api-performance.mjs","--logical-lists"],{cwd:process.cwd(),input,encoding:"utf8"});
    const summary = JSON.parse(output);
    expect(summary.operations).toEqual([
      expect.objectContaining({operationId:"operation-one",serverJoin:{attemptedRequestIds:2,matchedRequestIds:1,missingServerLogs:1,missingLogicalRecords:0,complete:false,functionCumulativeMs:11}}),
      expect.objectContaining({operationId:"operation-two",reusedInFlightRequestIds:1,serverJoin:{attemptedRequestIds:1,matchedRequestIds:1,missingServerLogs:0,missingLogicalRecords:0,complete:true,functionCumulativeMs:11}}),
      expect.objectContaining({operationId:"operation-three",complete:false,requestLinksComplete:false,droppedRequestLinks:3,serverJoin:{attemptedRequestIds:1,matchedRequestIds:0,missingServerLogs:1,missingLogicalRecords:0,complete:false,functionCumulativeMs:null}}),
    ]);
    expect(summary.physicalTotals).toEqual({attemptedRequestIds:3,matchedRequestIds:1,missingServerLogs:2,requestLinksComplete:false,droppedRequestLinks:3,missingLogicalRecords:0,complete:false,functionCumulativeMs:11});
    expect(output).not.toContain("shared-request");
    expect(output).not.toContain("missing-request");
    expect(output).not.toContain("PRIVATE_CANARY");
  });

  it("unions child request links into a parent and marks missing child records incomplete", () => {
    const base = {kind:"client.logical-list",schemaVersion:1,source:"full",result:"success",complete:true,error:"none",attempts:0,pages:0,emptyContinuationPages:0,continuationPages:0,restarts:0,itemCount:0,memberCount:0,rpcCumulativeMs:0,wallClockMs:1,requestLinksComplete:true,droppedRequestLinks:0};
    const input = [
      {...base,operationId:"parent",action:"home.refresh",childOperationIds:["child","missing-child"],requests:[]},
      {...base,operationId:"child",parentOperationId:"parent",action:"task.list",childOperationIds:[],attempts:1,requests:[{requestId:"child-request",reusedInFlight:false}]},
      {kind:"api.performance",action:"task.list",requestId:"child-request",durationMs:5,ok:true},
    ].map(value=>JSON.stringify(value)).join("\n");
    const summary = JSON.parse(execFileSync(process.execPath,["tools/summarize-api-performance.mjs","--logical-lists"],{cwd:process.cwd(),input,encoding:"utf8"}));
    expect(summary.operations[0]).toMatchObject({operationId:"parent",missingLogicalRecords:1,serverJoin:{attemptedRequestIds:1,matchedRequestIds:1,missingServerLogs:0,missingLogicalRecords:1,complete:false,functionCumulativeMs:5}});
    expect(summary.operations[1]).toMatchObject({operationId:"child",serverJoin:{attemptedRequestIds:1,matchedRequestIds:1,missingServerLogs:0,missingLogicalRecords:0,complete:true,functionCumulativeMs:5}});
    expect(summary.physicalTotals).toEqual({attemptedRequestIds:1,matchedRequestIds:1,missingServerLogs:0,requestLinksComplete:true,droppedRequestLinks:0,missingLogicalRecords:1,complete:false,functionCumulativeMs:5});
  });

  it("propagates a child ID generation failure through parent and global completeness", () => {
    const base = {kind:"client.logical-list",schemaVersion:1,source:"full",result:"success",complete:true,error:"none",attempts:1,pages:1,emptyContinuationPages:0,continuationPages:0,restarts:0,itemCount:1,memberCount:0,rpcCumulativeMs:1,wallClockMs:2,requestLinksComplete:true,droppedRequestLinks:0,missingChildOperationIds:0};
    const input = [
      {...base,operationId:"parent",action:"home.refresh",attempts:0,pages:0,itemCount:0,childOperationIds:["family","reminder"],requestLinksComplete:false,missingChildOperationIds:1,requests:[]},
      {...base,operationId:"family",parentOperationId:"parent",action:"family.list",childOperationIds:[],requests:[{requestId:"family-request",reusedInFlight:false}]},
      {...base,operationId:"reminder",parentOperationId:"parent",action:"reminder.list",childOperationIds:[],requests:[{requestId:"reminder-request",reusedInFlight:false}]},
      {kind:"api.performance",action:"family.list",requestId:"family-request",durationMs:3,ok:true},
      {kind:"api.performance",action:"reminder.list",requestId:"reminder-request",durationMs:4,ok:true},
    ].map(value=>JSON.stringify(value)).join("\n");
    const summary = JSON.parse(execFileSync(process.execPath,["tools/summarize-api-performance.mjs","--logical-lists"],{cwd:process.cwd(),input,encoding:"utf8"}));

    expect(summary.operations[0]).toMatchObject({
      operationId:"parent",requestLinksComplete:false,missingChildOperationIds:1,missingLogicalRecords:1,
      serverJoin:{attemptedRequestIds:2,matchedRequestIds:2,missingServerLogs:0,missingLogicalRecords:1,complete:false,functionCumulativeMs:7},
    });
    expect(summary.operations.slice(1)).toEqual([
      expect.objectContaining({operationId:"family",serverJoin:expect.objectContaining({complete:true})}),
      expect.objectContaining({operationId:"reminder",serverJoin:expect.objectContaining({complete:true})}),
    ]);
    expect(summary.physicalTotals).toEqual({attemptedRequestIds:2,matchedRequestIds:2,missingServerLogs:0,requestLinksComplete:false,droppedRequestLinks:0,missingLogicalRecords:1,complete:false,functionCumulativeMs:7});
  });

  it("unions all sibling pagination that completes after an early family error",()=>{
    const base={kind:"client.logical-list",schemaVersion:1,source:"full",complete:true,error:"none",emptyContinuationPages:0,continuationPages:0,restarts:0,itemCount:0,memberCount:0,rpcCumulativeMs:1,wallClockMs:2,requestLinksComplete:true,droppedRequestLinks:0};
    const input=[
      {...base,operationId:"parent",action:"home.refresh",result:"error",attempts:0,pages:0,childOperationIds:["family","task","reminder"],requests:[]},
      {...base,operationId:"family",parentOperationId:"parent",action:"family.list",result:"error",error:"unknown",attempts:1,pages:0,childOperationIds:[],requests:[{requestId:"family-request",reusedInFlight:false}]},
      {...base,operationId:"task",parentOperationId:"parent",action:"task.list",result:"success",attempts:2,pages:2,childOperationIds:[],requests:[{requestId:"task-1",reusedInFlight:false},{requestId:"task-2",reusedInFlight:false}]},
      {...base,operationId:"reminder",parentOperationId:"parent",action:"reminder.list",result:"success",attempts:1,pages:1,childOperationIds:[],requests:[{requestId:"reminder-request",reusedInFlight:false}]},
      ...[["family.list","family-request",1],["task.list","task-1",2],["task.list","task-2",3],["reminder.list","reminder-request",4]].map(([action,requestId,durationMs])=>({kind:"api.performance",action,requestId,durationMs,ok:true})),
    ].map(value=>JSON.stringify(value)).join("\n");
    const summary=JSON.parse(execFileSync(process.execPath,["tools/summarize-api-performance.mjs","--logical-lists"],{cwd:process.cwd(),input,encoding:"utf8"}));
    expect(summary.operations[0]).toMatchObject({operationId:"parent",serverJoin:{attemptedRequestIds:4,matchedRequestIds:4,missingServerLogs:0,missingLogicalRecords:0,complete:true,functionCumulativeMs:10}});
    expect(summary.physicalTotals).toMatchObject({attemptedRequestIds:4,matchedRequestIds:4,complete:true,functionCumulativeMs:10});
  });
});
