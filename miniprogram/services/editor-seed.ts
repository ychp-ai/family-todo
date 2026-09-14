import type { PersonalDraft } from "@family-todo/contracts";
let seed:PersonalDraft|null=null;
export function saveEditorSeed(draft:PersonalDraft){seed=JSON.parse(JSON.stringify(draft)) as PersonalDraft;}
export function takeEditorSeed(){const value=seed;seed=null;return value;}
