#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const logicalListMode = process.argv.includes("--logical-lists");
const inputPath = process.argv.slice(2).find(argument => argument !== "--logical-lists");
const source = inputPath ? createReadStream(inputPath, "utf8") : process.stdin;
const lines = createInterface({ input: source, crlfDelay: Infinity });
const actions = new Map();
const serverRequests = new Map();
const logicalLists = [];
const logicalActions = new Set(["home.refresh", "family.list", "task.list", "reminder.list", "progress.get", "task.recycleList", "task.history", "virtualMember.list"]);
const logicalSources = new Set(["full", "unchanged", "cache", "no-cache-fallback"]);
const logicalResults = new Set(["success", "partial", "cancelled", "error"]);
const logicalErrors = new Set(["none", "cursor-expired", "invalid-continuation", "api", "unknown"]);
const numeric = value => typeof value === "number" && Number.isFinite(value) ? value : 0;
const collections = ["identities", "users", "user_scopes", "tasks", "task_events", "idempotency_receipts", "query_sessions", "families", "memberships", "membership_slots", "virtual_members", "invitations", "family_events", "reminder_preferences", "reminder_receipts", "schedule_segments", "schedule_controls", "occurrence_states", "historical_subject_access", "other"];
const collectionSet = new Set(collections);
const operations = ["documentRead", "documentWrite", "query"];
const emptyDatabaseOperations = () => Object.fromEntries(collections.map(collection => [collection, Object.fromEntries(operations.map(operation => [operation, 0]))]));
for await (const line of lines) {
  let value;
  try { value = JSON.parse(line); } catch { continue; }
  if (value?.kind === "client.logical-list" && value.schemaVersion === 1 && typeof value.operationId === "string" && logicalActions.has(value.action) && Array.isArray(value.requests)) {
    logicalLists.push(value); continue;
  }
  if (value?.kind !== "api.performance" || typeof value.action !== "string") continue;
  if (typeof value.requestId === "string" && !serverRequests.has(value.requestId)) serverRequests.set(value.requestId, {action:value.action,durationMs:typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? value.durationMs : null});
  const current = actions.get(value.action) ?? { action: value.action, calls: 0, errors: 0, durations: [], databaseWaitCumulativeMs: 0, serializationMs: 0, responseBytes: 0, documentReads: 0, documentWrites: 0, queries: 0, returnedRows: 0, transactions: 0, retries: 0, databaseOperations: emptyDatabaseOperations() };
  current.calls += 1; current.errors += value.ok === false ? 1 : 0; current.durations.push(numeric(value.durationMs));
  for (const key of ["databaseWaitCumulativeMs", "serializationMs", "responseBytes", "documentReads", "documentWrites", "queries", "returnedRows", "transactions", "retries"]) current[key] += numeric(value[key]);
  if (value.databaseOperations && typeof value.databaseOperations === "object" && !Array.isArray(value.databaseOperations)) {
    for (const [collection, counts] of Object.entries(value.databaseOperations)) {
      if (!collectionSet.has(collection) || !counts || typeof counts !== "object" || Array.isArray(counts)) continue;
      for (const operation of operations) current.databaseOperations[collection][operation] += numeric(counts[operation]);
    }
  }
  actions.set(value.action, current);
}
if (logicalListMode) {
  const fixed = (value, fallback = 0) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  const logicalById = new Map(logicalLists.map(value => [value.operationId, value]));
  const operationLinks = (value, ancestors = new Set()) => {
    if (ancestors.has(value.operationId)) return {requests:new Map(),requestLinksComplete:false,droppedRequestLinks:0,missingLogicalRecords:1};
    const nextAncestors = new Set(ancestors).add(value.operationId), requests = new Map();
    for (const request of value.requests) if (request && typeof request.requestId === "string") {
      const previous = requests.get(request.requestId);
      requests.set(request.requestId, {action:value.action,reused:previous?.reused === true || request.reusedInFlight === true});
    }
    const missingChildOperationIds = fixed(value.missingChildOperationIds);
    let requestLinksComplete = value.requestLinksComplete === true && missingChildOperationIds === 0, droppedRequestLinks = fixed(value.droppedRequestLinks), missingLogicalRecords = missingChildOperationIds;
    const childIds = Array.isArray(value.childOperationIds) ? [...new Set(value.childOperationIds.filter(id => typeof id === "string"))] : [];
    for (const childId of childIds) {
      const child = logicalById.get(childId);
      if (!child) { missingLogicalRecords++; continue; }
      const nested = operationLinks(child, nextAncestors);
      requestLinksComplete &&= nested.requestLinksComplete;
      droppedRequestLinks += nested.droppedRequestLinks;
      missingLogicalRecords += nested.missingLogicalRecords;
      for (const [requestId, link] of nested.requests) {
        const previous = requests.get(requestId);
        requests.set(requestId, {action:previous?.action ?? link.action,reused:previous?.reused === true || link.reused});
      }
    }
    return {requests,requestLinksComplete,droppedRequestLinks,missingLogicalRecords};
  };
  const globalRequests = new Map();
  let requestLinksComplete = true, droppedRequestLinks = 0, missingLogicalRecords = 0;
  const operationsOutput = logicalLists.map(value => {
    const links = operationLinks(value), unique = links.requests;
    let matchedRequestIds = 0, functionCumulativeMs = 0;
    for (const [requestId, link] of unique) {
      const server = serverRequests.get(requestId);
      if (server && server.action === link.action) { matchedRequestIds++; if (server.durationMs !== null) functionCumulativeMs += server.durationMs; }
      if (!globalRequests.has(requestId)) globalRequests.set(requestId, link.action);
    }
    const attemptedRequestIds = unique.size, missingServerLogs = attemptedRequestIds - matchedRequestIds;
    const linksComplete = links.requestLinksComplete;
    return {
      operationId:value.operationId,
      ...(typeof value.parentOperationId === "string" ? {parentOperationId:value.parentOperationId} : {}),
      childOperationIds:Array.isArray(value.childOperationIds) ? value.childOperationIds.filter(id => typeof id === "string") : [],
      action:value.action,
      source:logicalSources.has(value.source)?value.source:"full",
      result:logicalResults.has(value.result)?value.result:"error",
      complete:value.complete===true,
      error:logicalErrors.has(value.error)?value.error:"unknown",
      attempts:fixed(value.attempts), pages:fixed(value.pages), emptyContinuationPages:fixed(value.emptyContinuationPages), continuationPages:fixed(value.continuationPages), restarts:fixed(value.restarts),
      itemCount:fixed(value.itemCount), memberCount:fixed(value.memberCount), rpcCumulativeMs:fixed(value.rpcCumulativeMs), wallClockMs:fixed(value.wallClockMs),
      requestLinksComplete:linksComplete,droppedRequestLinks:links.droppedRequestLinks,missingChildOperationIds:fixed(value.missingChildOperationIds),missingLogicalRecords:links.missingLogicalRecords,
      reusedInFlightRequestIds:[...unique.values()].filter(link=>link.reused).length,
      serverJoin:{attemptedRequestIds,matchedRequestIds,missingServerLogs,missingLogicalRecords:links.missingLogicalRecords,complete:linksComplete&&links.missingLogicalRecords===0&&missingServerLogs===0,functionCumulativeMs:matchedRequestIds?functionCumulativeMs:null},
    };
  });
  for (const value of logicalLists) {
    const missingChildOperationIds = fixed(value.missingChildOperationIds);
    requestLinksComplete &&= value.requestLinksComplete === true && missingChildOperationIds === 0;
    droppedRequestLinks += fixed(value.droppedRequestLinks);
    missingLogicalRecords += missingChildOperationIds;
    for (const childId of Array.isArray(value.childOperationIds) ? new Set(value.childOperationIds.filter(id=>typeof id==="string")) : []) if (!logicalById.has(childId)) missingLogicalRecords++;
  }
  let matchedRequestIds = 0, functionCumulativeMs = 0;
  for (const [requestId, action] of globalRequests) { const server=serverRequests.get(requestId);if(server&&server.action===action){matchedRequestIds++;if(server.durationMs!==null)functionCumulativeMs+=server.durationMs;} }
  const attemptedRequestIds=globalRequests.size,missingServerLogs=attemptedRequestIds-matchedRequestIds;
  process.stdout.write(`${JSON.stringify({kind:"client.logical-list.summary",operations:operationsOutput,physicalTotals:{attemptedRequestIds,matchedRequestIds,missingServerLogs,requestLinksComplete,droppedRequestLinks,missingLogicalRecords,complete:requestLinksComplete&&missingLogicalRecords===0&&missingServerLogs===0,functionCumulativeMs:matchedRequestIds?functionCumulativeMs:null}},null,2)}\n`);
  process.exit(0);
}
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : 0;
const output = [...actions.values()].map(({ durations, ...item }) => ({ ...item, durationP50Ms: percentile(durations, .5), durationP95Ms: percentile(durations, .95) }))
  .sort((a, b) => (b.documentReads + b.documentWrites + b.queries) - (a.documentReads + a.documentWrites + a.queries) || b.calls - a.calls || a.action.localeCompare(b.action));
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
