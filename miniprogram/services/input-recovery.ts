import type { Subject } from "@family-todo/contracts";
import { isRecord, isSubject, isUuid } from "../shared/contracts";
import { createRequestId } from "./request-id";
import { personalApi } from "./personal-api";
import type { ScheduleFields } from "./schedule-draft";
import { wxRecoveryStorage } from "./write-recovery";
import type { RecoveryStorage } from "./write-recovery";

export type DraftInput = ScheduleFields & {title:string;note:string;familyId:string|null;subject:Subject;viewers:string[];remindMe:boolean};
export type InputRecord = {schema:1;id:string;version:number;input:DraftInput};
const fields = ["repeat","date","time","endDate","title","note"];
export function isInputRecord(value:unknown):value is InputRecord {
  if(!isRecord(value)||Object.keys(value).some(k=>!["schema","id","version","input"].includes(k))||value.schema!==1||!isUuid(value.id)||!Number.isSafeInteger(value.version)||Number(value.version)<0||!isRecord(value.input))return false;
  const input=value.input;
  return Object.keys(input).length===12&&Object.keys(input).every(k=>[...fields,"familyId","subject","viewers","remindMe","times","weekdays"].includes(k))&&fields.every(k=>typeof input[k]==="string")&&["once","daily","weekly"].includes(String(input.repeat))&&(input.familyId===null||isUuid(input.familyId))&&isSubject(input.subject)&&typeof input.remindMe==="boolean"&&Array.isArray(input.viewers)&&input.viewers.every(isUuid)&&Array.isArray(input.times)&&input.times.every(t=>typeof t==="string")&&Array.isArray(input.weekdays)&&input.weekdays.every(d=>Number.isInteger(d)&&d>=1&&d<=7);
}
export const INPUT_STORAGE_ERROR="输入尚未可靠保留，请重试保存草稿后再离开。";
/** Bound to a verified identity generation. A stale page cannot touch another session's drafts. */
export class InputRecovery {
  public record:InputRecord|null=null;
  private readonly generation=personalApi.recoveryGeneration;
  private readonly context=personalApi.recoveryContext;
  private readonly key:string;
  public constructor(target:string,private readonly storage:RecoveryStorage=wxRecoveryStorage){this.key=this.context+":input:"+encodeURIComponent(target);}
  public get current(){return this.context!==null&&this.context===personalApi.recoveryContext&&this.generation===personalApi.recoveryGeneration;}
  public load():InputRecord|null {
    this.assertCurrent();
    try{this.record=null;const value=this.storage.read(this.key);if(value===undefined||value==="")return null;if(!isInputRecord(value))throw new Error(INPUT_STORAGE_ERROR);this.record=value;if(personalApi.isDraftCompleted(value.id)){this.remove();return null;}return value;}catch{throw new Error(INPUT_STORAGE_ERROR);}
  }
  public async start(){this.assertCurrent();const id=await createRequestId();this.assertCurrent();this.record={schema:1,id,version:0,input:{title:"",note:"",familyId:null,subject:{kind:"self"},viewers:[],remindMe:true,repeat:"once",date:"",time:"",endDate:"",times:[],weekdays:[]}};}
  public save(input:DraftInput,version:number){this.assertCurrent();if(!this.record)throw new Error(INPUT_STORAGE_ERROR);if(personalApi.isDraftCompleted(this.record.id)){this.remove();throw new Error("上次保存已确认，请重新进入查看结果，勿重复新建。");}const record:InputRecord={schema:1,id:this.record.id,version,input};if(!isInputRecord(record))throw new Error(INPUT_STORAGE_ERROR);try{const current=this.storage.read(this.key);if(current!==undefined&&current!==""&&(!isInputRecord(current)||current.id!==record.id))throw new Error(INPUT_STORAGE_ERROR);this.storage.write(this.key,record);this.record=record;}catch{throw new Error(INPUT_STORAGE_ERROR);}}
  public remove(){this.assertCurrent();if(!this.record)return;const id=this.record.id;try{const current=this.storage.read(this.key);if(current!==undefined&&current!==""&&(!isInputRecord(current)||current.id!==id))throw new Error(INPUT_STORAGE_ERROR);this.storage.remove(this.key);this.record=null;personalApi.forgetDraftCompletion(id);}catch{throw new Error(INPUT_STORAGE_ERROR);}}
  private assertCurrent(){if(!this.current)throw new Error("账号已变更，请重新进入后编辑。");}
}

export type RecoveryIdentity = {context:string|null;generation:number};
export function captureRecoveryIdentity():RecoveryIdentity {return {context:personalApi.recoveryContext,generation:personalApi.recoveryGeneration};}
export function isRecoveryIdentityCurrent(identity:RecoveryIdentity):boolean {return identity.context===personalApi.recoveryContext&&identity.generation===personalApi.recoveryGeneration;}
