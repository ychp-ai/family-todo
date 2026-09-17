import { isPersonalData, isFamilyData } from "@family-todo/contracts";
import type { PersonalAction, PersonalActionMap, FamilyAction, FamilyActionMap, UnchangedList } from "@family-todo/contracts";
/** Legacy callers do not opt in and must always receive the ordinary result. */
export function isFullPersonalData<A extends PersonalAction>(action: A, value: unknown): value is Exclude<PersonalActionMap[A]["data"], UnchangedList> {
  return isPersonalData(action, value) && !(typeof value === "object" && value !== null && "unchanged" in value);
}
export function isFullFamilyData<A extends FamilyAction>(action: A, value: unknown): value is Exclude<FamilyActionMap[A]["data"], UnchangedList> {
  return isFamilyData(action, value) && !(typeof value === "object" && value !== null && "unchanged" in value);
}
