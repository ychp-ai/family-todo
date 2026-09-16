import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ApiRequest } from "@family-todo/contracts";
import { AppApiClient } from "./app-api-client";
import { PersonalApi, personalApi } from "./personal-api";
import { previewExit, previewTransfer, listManagedVirtualMembers } from "./family-api";

describe("家庭服务与分页",()=>{
  it("管理名单显式请求在用与停用两类无账号成员",async()=>{const read=vi.spyOn(personalApi,"read").mockResolvedValue({items:[],nextCursor:null,complete:true,asOf:"2026-09-12T00:00:00.000Z"});await listManagedVirtualMembers("family");expect(read.mock.calls.map(call=>call[1])).toEqual([{familyId:"family",status:"active",limit:50},{familyId:"family",status:"inactive",limit:50}]);});
  it("跨页面未决写保留原完整 payload，拒绝用新参数开始另一次写",async()=>{const sent:ApiRequest[]=[];const id=randomUUID();const api=new PersonalApi(new AppApiClient({send:async req=>{sent.push(req);if(sent.length===1)throw new Error("lost");return {ok:true,requestId:req.requestId,data:{id,version:2,transferred:true}};}}),async()=>randomUUID());const payload={familyId:id,toMembershipId:randomUUID(),previewToken:"original",expectedFamilyVersion:1};await expect(api.write("family.transferOwnership",payload)).rejects.toMatchObject({retryable:true});payload.previewToken="changed";await expect(api.write("family.transferOwnership",payload)).rejects.toMatchObject({code:"PENDING_WRITE"});await api.retryPending();expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);expect(api.pendingCount).toBe(0);});
  it("邀请响应执行 unknown guard，非法口令响应保留未决操作",async()=>{const api=new PersonalApi(new AppApiClient({send:async req=>({ok:true,requestId:req.requestId,data:{id:randomUUID(),token:"demo",expiresAt:"2026-09-19T00:00:00.000Z",version:1}})}),async()=>randomUUID());await expect(api.write("invitation.create",{familyId:randomUUID(),expectedFamilyVersion:1})).rejects.toMatchObject({retryable:true});expect(api.pendingCount).toBe(1);});
  it("退出预览继续扫描空页，complete 前不能发布计数",async()=>{const expected={previewToken:"token",expiresAt:"2026-09-12T00:05:00.000Z",familyVersion:3,targetName:"家人",successorName:"拥有人",ownedTaskCount:4,privateTaskCount:2,createdManagementCount:1,virtualTaskCount:0,otherScopesUnaffected:true as const};const read=vi.spyOn(personalApi,"read").mockResolvedValueOnce({preview:null,complete:false,nextCursor:"page2"}).mockResolvedValueOnce({preview:expected,complete:true,nextCursor:null});const input={familyId:randomUUID(),targetMembershipId:randomUUID(),mode:"leave" as const};await expect(previewExit(input)).resolves.toEqual(expected);expect(read.mock.calls[1]?.[1]).toEqual({...input,cursor:"page2"});});
  it("转交预览循环游标会报错，不以零项代替未完成扫描",async()=>{vi.spyOn(personalApi,"read").mockResolvedValue({preview:null,complete:false,nextCursor:"same"});await expect(previewTransfer({familyId:randomUUID(),toMembershipId:randomUUID()})).rejects.toThrow("未完整加载");});
});

it("家庭概览人数包含真实与在用无账号成员，失败时不伪造零人数", async () => {
  const { familyOverviews } = await import("./family-api");
  const summaries = ["a", "b"].map(id => ({ id, name: id, ownerName: "家人", myMembershipId: "me", myRole: "owner" as const, version: 1 }));
  vi.spyOn(personalApi, "read").mockResolvedValueOnce({ family: { id: "a", name: "家", version: 1, myMembershipId: "me", ownerMembershipId: "me", authEpoch: 1 }, members: ["me", "other"].map(id => ({ id, familyId: "a", name: id, status: "active" as const, role: "member" as const, version: 1, isMe: id === "me" })), virtualMembers: ["active", "inactive"].map(status => ({ id: status, familyId: "a", name: status, status: status === "active" ? "active" as const : "inactive" as const, version: 1 })) }).mockRejectedValueOnce(new Error("unavailable"));
  const result = await familyOverviews(summaries);
  expect(result[0]).toMatchObject({ id: "a", memberCount: 3 });
  expect(result[1]).toEqual(summaries[1]);
});
