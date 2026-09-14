import type { Schedule } from "@family-todo/contracts";
import { isSchedule } from "../shared/contracts";
export type ScheduleFields = {repeat:string;date:string;time:string;endDate:string;times:string[];weekdays:number[]};
export function scheduleFields(schedule?:Schedule):ScheduleFields {
  if(!schedule||schedule.kind==="once")return {repeat:"once",date:schedule?.date??"",time:schedule?.time??"",endDate:"",times:[],weekdays:[]};
  return {repeat:schedule.kind,date:schedule.startDate,time:"",endDate:schedule.endDate??"",times:[...schedule.times],weekdays:schedule.kind==="weekly"?[...schedule.weekdays]:[]};
}
export function draftSchedule(fields:ScheduleFields):Schedule {
  const {repeat,date,time,endDate,times,weekdays}=fields;
  if(repeat==="weekly"&&!weekdays.length)throw new Error("每周至少选择一天。");
  if(repeat!=="once"&&times.length>6)throw new Error("每天最多设置 6 个时刻。");
  if(repeat!=="once"&&new Set(times).size!==times.length)throw new Error("时刻不能重复，请调整后再保存。");
  if(repeat!=="once"&&times.some(t=>!t))throw new Error("请选择时刻，或删除空时刻。");
  const schedule:unknown=repeat==="once"?{kind:"once",date:date||null,time:time||null}:{kind:repeat,startDate:date,endDate:endDate||null,times,...(repeat==="weekly"?{weekdays}:{})};
  if(!isSchedule(schedule))throw new Error("请核对日期、结束日期及具体时刻。");
  return schedule;
}
