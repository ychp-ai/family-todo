import { localConfig } from "./local";
import type { AppConfig } from "./types";

export const appConfig: Readonly<AppConfig> = Object.freeze({ ...localConfig });
