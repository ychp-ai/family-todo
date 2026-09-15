import { familyProgress } from "../../services/family-progress";
import { patchData } from "../../services/patch-data";
import { componentActions } from "../../services/component-events";
import { readLocalProfile, saveLocalProfile } from "../../services/local-profile";
import { consumeFamilyDestination } from "../../services/family-navigation";
import type { MemberProgress, FamilySummary, FamilyDTO, MemberDTO, VirtualDTO, ExitInput, TransferInput, ExitPreview, TransferPreview } from "@family-todo/contracts";
import { familyApi, familyOverviews, listFamilies, previewExit, previewTransfer } from "../../services/family-api";
import { PersonalApiError, isAccessDenied } from "../../services/personal-api";
import { dateAt, errorMessage, navigationMetrics, readySession } from "../../services/personal-view";
Page({
  onComponentAction: componentActions(["avatarError", "openProfile", "deleteVirtual", "join", "openCreate", "progress", "recycle", "renameMember", "renameVirtual", "select", "startExit"]),
  data:{avatarPath:"",profileAvatar:"",profileName:"",profileError:"",profileSaving:false,displayName:"",avatarInitial:"",statusHeight:0,navHeight:44,capsuleWidth:100,status:"loading",error:"",families:[] as FamilySummary[],id:"",family:null as FamilyDTO|null,members:[] as (MemberDTO & {progress?:MemberProgress|null})[],virtualMembers:[] as (VirtualDTO & {progress?:MemberProgress|null})[],progressLoading:false,progressError:"",progressDate:"",owner:false,ownerName:"",sheet:"",name:"",myName:"",formTitle:"",writing:false,uncertain:false,previewLoading:false,exit:null as ExitPreview|null,transfer:null as TransferPreview|null,targets:[] as MemberDTO[],targetIndex:0,previewError:""},
  progressEpoch:0,deleteConfirming:false,profileUserId:"",alive:true,visible:false,epoch:0,editId:"",editVersion:0,exitInput:null as ExitInput|null,transferInput:null as TransferInput|null,pending:null as (()=>Promise<unknown>)|null,
  onLoad(query:Record<string,string|undefined>){patchData(this, {...navigationMetrics(),id:query.id??""});},
  onShow(){this.visible=true;if(this.data.sheet==="profile")return;const destination=consumeFamilyDestination();if(destination!==null&&!this.pending)patchData(this, {id:destination,...(destination!==this.data.id?{status:"loading",family:null,members:[],virtualMembers:[]}:{})});void this.load();},onHide(){this.visible=false;this.epoch++;},onUnload(){this.alive=false;this.visible=false;this.epoch++;},
  async load(){if(this.pending)return;const epoch=++this.epoch;patchData(this, {error:"",exit:null,transfer:null,previewLoading:false,sheet:"",...(!["ready","empty"].includes(this.data.status)?{status:"loading"}:{})});try{const user=await readySession();if(!this.visible||epoch!==this.epoch)return;if(this.profileUserId!==user.id){const profile=readLocalProfile(user.id);const displayName=profile?.displayName??user.displayName;patchData(this, {displayName,avatarInitial:[...displayName][0]??"我",avatarPath:profile?.avatarPath??""});this.profileUserId=user.id;}const id=this.data.id;const result=id?null:await listFamilies();if(!this.visible||epoch!==this.epoch)return;const overviews=result?await familyOverviews(result.items):this.data.families;if(!this.visible||epoch!==this.epoch)return;const progressDate=dateAt(result?.last.asOf??new Date().toISOString());const progressRead=id?Promise.allSettled([familyProgress(id,progressDate,()=>this.visible&&epoch===this.epoch)]):undefined;const detail=id?await familyApi.read("family.get",{id}):null;const virtualMembers=detail?.virtualMembers??[];if(!this.visible||epoch!==this.epoch)return;patchData(this, {status:id||result?.items.length?"ready":"empty",families:overviews,id,family:detail?.family??null,members:(detail?.members??[]).map(member=>({...member,...(this.data.members.find(m=>m.id===member.id)?.progress?{progress:this.data.members.find(m=>m.id===member.id)?.progress}:{})})),virtualMembers:virtualMembers.filter(member=>member.status==="active").map(member=>({...member,...(this.data.virtualMembers.find(m=>m.id===member.id)?.progress?{progress:this.data.virtualMembers.find(m=>m.id===member.id)?.progress}:{})})),owner:detail?.family.myMembershipId===detail?.family.ownerMembershipId&&!!detail,ownerName:detail?.members.find(m=>m.role==="owner")?.name??"",targets:detail?.members.filter(m=>!m.isMe)??[],progressDate});if(id)void this.loadProgress(progressRead);}catch(error){if(this.alive&&epoch===this.epoch){if(isAccessDenied(error))this.clearCurrentFamily();patchData(this, {status:"error",error:errorMessage(error),family:null,members:[],virtualMembers:[],sheet:""});}}},
  retryProgress(){void this.loadProgress();},
  async loadProgress(prefetched?:Promise<PromiseSettledResult<MemberProgress[]>[]>){
    const familyId=this.data.family?.id,date=this.data.progressDate;
    if(!familyId||!date||!this.visible)return;
    const epoch=++this.progressEpoch,pageEpoch=this.epoch;
    const active=()=>this.visible&&epoch===this.progressEpoch&&pageEpoch===this.epoch&&this.data.family?.id===familyId;
    patchData(this, {progressLoading:true,progressError:""});
    try{
      const [result]=await (prefetched??Promise.allSettled([familyProgress(familyId,date,active)]));
      if(!result)throw new Error("进度未完整加载，请重试。");
      if(result.status==="rejected")throw result.reason;
      const progress=result.value;
      if(!active())return;
      patchData(this, {members:this.data.members.map(member=>({...member,progress:progress.find(p=>p.subject.kind==="member"&&p.subject.membershipId===member.id)??null})),virtualMembers:this.data.virtualMembers.map(member=>({...member,progress:progress.find(p=>p.subject.kind==="virtual"&&p.subject.virtualMemberId===member.id)??null})),progressLoading:false});
    }catch(error){if(active()){if(isAccessDenied(error)){this.clearCurrentFamily();patchData(this, {error:errorMessage(error)});}else patchData(this, {members:this.data.members.map(({progress,...member})=>member),virtualMembers:this.data.virtualMembers.map(({progress,...member})=>member),progressError:errorMessage(error)});}}
    finally{if(this.visible&&epoch===this.progressEpoch)patchData(this, {progressLoading:false});}
  },
  openProfile(){if(!this.profileUserId||this.pending)return;patchData(this, {sheet:"profile",formTitle:"头像与昵称",profileName:this.data.displayName,profileAvatar:this.data.avatarPath,profileError:""});},
  chooseAvatar(e:WechatMiniprogram.CustomEvent<{avatarUrl?:string}>){if(this.data.sheet!=="profile"||this.data.profileSaving)return;const path=e.detail.avatarUrl;if(typeof path==="string"&&path)patchData(this, {profileAvatar:path,profileError:""});},
  profileNickname(e:WechatMiniprogram.Input){patchData(this, {profileName:e.detail.value,profileError:""});},
  nicknameReview(e:WechatMiniprogram.CustomEvent<{pass?:boolean}>){if(e.detail.pass===false)patchData(this, {profileName:"",profileError:"昵称未通过微信检查，请重新填写。"});},
  avatarError(){patchData(this, {avatarPath:""});},
  async saveProfile(e:WechatMiniprogram.CustomEvent<{value:Record<string,unknown>}>){
    if(this.data.profileSaving||this.data.sheet!=="profile")return;
    const name=e.detail.value.nickname;
    if(typeof name!=="string"||!name.trim()||[...name.trim()].length>32){patchData(this, {profileError:"请填写 1–32 个字的昵称。"});return;}
    const userId=this.profileUserId;
    patchData(this, {profileSaving:true,profileError:""});
    try{const user=await readySession();if(!this.alive||this.data.sheet!=="profile")return;if(user.id!==userId)throw new Error("账号已变化，请重新进入家庭页。");const profile=saveLocalProfile(userId,name,this.data.profileAvatar);patchData(this, {displayName:profile.displayName,avatarInitial:[...profile.displayName][0]??"我",avatarPath:profile.avatarPath,sheet:""});}
    catch(error){if(this.alive)patchData(this, {profileError:errorMessage(error)});}
    finally{if(this.alive)patchData(this, {profileSaving:false});}
  },
  select(e:WechatMiniprogram.TouchEvent){const id:unknown=e.currentTarget.dataset.id;if(typeof id!=="string"||this.pending)return;patchData(this, {id,status:"loading",family:null,members:[],virtualMembers:[]});void this.load();},
  allFamilies(){patchData(this, {id:"",family:null,members:[],virtualMembers:[]});void this.load();},
  progress(){wx.navigateTo({url:"/pages/progress/index"});},
  recycle(){const id=this.data.family?.id;wx.navigateTo({url:`/pages/recycle/index${id?`?familyId=${encodeURIComponent(id)}`:""}`});},
  join(){wx.navigateTo({url:"/pages/invitation/index"});},
  invite(){wx.navigateTo({url:`/pages/invitation/index?familyId=${this.data.id}`});},
  openCreate(){patchData(this, {sheet:"create",formTitle:this.data.families.length?"创建另一个家庭":"创建家庭",name:"",myName:"",error:""});},
  renameFamily(){const f=this.data.family;if(!f||!this.data.owner)return;this.editId=f.id;this.editVersion=f.version;patchData(this, {sheet:"family",formTitle:"修改家庭名称",name:f.name,error:""});},
  renameMember(e:WechatMiniprogram.TouchEvent){const member=this.data.members.find(m=>m.id===e.currentTarget.dataset.id);if(!member||(!member.isMe&&!this.data.owner))return;this.editId=member.id;this.editVersion=member.version;patchData(this, {sheet:"member",formTitle:"修改称呼",name:member.name,error:""});},
  addVirtual(){if(this.data.owner)patchData(this, {sheet:"addVirtual",formTitle:"添加无账号成员",name:"",error:""});},
  renameVirtual(e:WechatMiniprogram.TouchEvent){const member=this.data.virtualMembers.find(m=>m.id===e.currentTarget.dataset.id);if(!member||!this.data.owner)return;this.editId=member.id;this.editVersion=member.version;patchData(this, {sheet:"virtual",formTitle:"修改称呼",name:member.name,error:""});},
  nameInput(e:WechatMiniprogram.Input){patchData(this, {name:e.detail.value});},myNameInput(e:WechatMiniprogram.Input){patchData(this, {myName:e.detail.value});},noop(){},
  closeSheet(){if(this.data.profileSaving||this.data.writing||this.data.uncertain||this.data.previewLoading)return;patchData(this, {sheet:"",error:"",previewError:"",exit:null,transfer:null});},
  async run(run:()=>Promise<unknown>){if(this.data.writing)return;this.pending??=run;patchData(this, {writing:true,error:""});try{await this.pending();this.pending=null;if(this.alive){patchData(this, {uncertain:false,sheet:""});await this.load();}}catch(error){const uncertain=error instanceof PersonalApiError&&error.retryable;if(!uncertain)this.pending=null;if(this.alive){if(isAccessDenied(error))this.clearCurrentFamily();patchData(this, {uncertain,error:error instanceof PersonalApiError&&error.code==="PREVIEW_EXPIRED"?"预览已过期，请重新查看交接影响。":errorMessage(error),...(error instanceof PersonalApiError&&error.code==="PREVIEW_EXPIRED"?{exit:null,transfer:null}:{})});}}finally{if(this.alive)patchData(this, {writing:false});}},
  clearCurrentFamily(){const id=this.data.id;this.epoch++;this.editId="";this.editVersion=0;this.exitInput=null;this.transferInput=null;patchData(this, {status:"error",id:"",family:null,members:[],virtualMembers:[],families:this.data.families.filter(family=>family.id!==id),owner:false,ownerName:"",targets:[],targetIndex:0,sheet:"",name:"",myName:"",formTitle:"",exit:null,transfer:null,previewLoading:false,previewError:""});},
  retryWrite(){if(this.pending)void this.run(this.pending);},
  async save(){const name=this.data.name.trim();if(!name||[...name].length>(this.data.sheet==="create"||this.data.sheet==="family"?24:12)){patchData(this, {error:"请填写有效的名称或称呼。"});return;}const f=this.data.family;const ref={id:this.editId,expectedVersion:this.editVersion,name};switch(this.data.sheet){case "create":{const myName=this.data.myName.trim();if(!myName||[...myName].length>12){patchData(this, {error:"请填写 1–12 个字的家庭称呼。"});return;}await this.run(async()=>{const result=await familyApi.write("family.create",{name,myName});if(this.alive)patchData(this, {id:result.family.id});});break;}case "family":await this.run(()=>familyApi.write("family.update",ref));break;case "member":await this.run(()=>familyApi.write("member.rename",ref));break;case "virtual":await this.run(()=>familyApi.write("virtualMember.update",ref));break;case "addVirtual":if(f){const input={familyId:f.id,expectedFamilyVersion:f.version,name};await this.run(()=>familyApi.write("virtualMember.create",input));}break;}},
  async deleteVirtual(e:WechatMiniprogram.TouchEvent){
    const member=this.data.virtualMembers.find(m=>m.id===e.currentTarget.dataset.id);
    if(!member||member.status!=="active"||!this.data.owner||this.pending||this.data.writing||this.deleteConfirming)return;
    const familyId=this.data.id;const epoch=this.epoch;
    this.deleteConfirming=true;
    try{
      const answer=await wx.showModal({title:"删除这位家庭成员？",content:`删除“${member.name}”后将不再显示在成员列表，也不能用于新事项。历史记录保留，未结束事项继续由家庭拥有人管理。`,confirmText:"删除成员",confirmColor:"#c44747"});
      if(!answer.confirm||!this.visible||epoch!==this.epoch||familyId!==this.data.id||!this.data.owner||this.pending)return;
      const input={id:member.id,expectedVersion:member.version};
      await this.run(()=>familyApi.write("virtualMember.deactivate",input));
    }finally{this.deleteConfirming=false;}
  },
  startTransfer(){if(!this.data.owner)return;if(!this.data.targets.length){patchData(this, {sheet:"noSuccessor",formTitle:"还没有可承接的家人"});return;}patchData(this, {sheet:"transfer",formTitle:"转交家庭拥有权",transfer:null,exit:null,targetIndex:0,previewError:""});void this.loadTransfer();},
  targetChange(e:WechatMiniprogram.PickerChange){if(this.pending||this.data.previewLoading)return;patchData(this, {targetIndex:Number(e.detail.value),transfer:null});void this.loadTransfer();},
  async loadTransfer(){const target=this.data.targets[this.data.targetIndex];if(!target||this.pending)return;this.transferInput={familyId:this.data.id,toMembershipId:target.id};const input=this.transferInput;const epoch=++this.epoch;patchData(this, {previewLoading:true,previewError:"",transfer:null});try{const result=await previewTransfer(input);if(this.visible&&epoch===this.epoch)patchData(this, {transfer:result});}catch(error){if(this.alive&&epoch===this.epoch){if(isAccessDenied(error)){this.clearCurrentFamily();patchData(this, {error:errorMessage(error)});}else if(this.visible)patchData(this, {previewError:errorMessage(error)});}}finally{if(this.visible&&epoch===this.epoch)patchData(this, {previewLoading:false});}},
  startExit(e:WechatMiniprogram.TouchEvent){const f=this.data.family;if(!f)return;const id:unknown=e.currentTarget.dataset.id;const target=this.data.members.find(m=>m.id===(typeof id==="string"?id:f.myMembershipId));if(!target||this.pending||this.data.writing||(!target.isMe&&!this.data.owner))return;if(target.role==="owner"){this.startTransfer();return;}this.exitInput={familyId:f.id,targetMembershipId:target.id,mode:target.isMe?"leave":"remove"};patchData(this, {sheet:"exit",formTitle:target.isMe?"确认退出这个家庭？":`确认删除“${target.name}”？`,exit:null,transfer:null});void this.loadExit();},
  async loadExit(){if(!this.exitInput||this.pending)return;const input=this.exitInput;const epoch=++this.epoch;patchData(this, {previewLoading:true,previewError:"",exit:null});try{const result=await previewExit(input);if(this.visible&&epoch===this.epoch)patchData(this, {exit:result});}catch(error){if(this.alive&&epoch===this.epoch){if(isAccessDenied(error)){this.clearCurrentFamily();patchData(this, {error:errorMessage(error)});}else if(this.visible)patchData(this, {previewError:errorMessage(error)});}}finally{if(this.visible&&epoch===this.epoch)patchData(this, {previewLoading:false});}},
  async confirmExit(){const preview=this.data.exit;if(!preview||!this.exitInput||this.data.previewLoading)return;const input={...this.exitInput,previewToken:preview.previewToken,expectedFamilyVersion:preview.familyVersion};await this.run(async()=>{await familyApi.write("family.exit",input);if(input.mode==="leave"&&this.alive)patchData(this, {id:"",family:null,members:[],virtualMembers:[]});});},
  async confirmTransfer(){const preview=this.data.transfer;if(!preview||!this.transferInput||this.data.previewLoading)return;const input={...this.transferInput,previewToken:preview.previewToken,expectedFamilyVersion:preview.familyVersion};await this.run(async()=>{await familyApi.write("family.transferOwnership",input);if(this.alive)wx.showToast({title:"拥有权已转交；退出需另行确认",icon:"none"});});},
});
