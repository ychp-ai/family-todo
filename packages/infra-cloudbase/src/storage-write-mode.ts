/** Compatibility releases keep legacy redundancy while reading both document formats. */
export function legacyStorageWrites(): boolean {
  return process.env.FAMILY_TODO_STORAGE_WRITE_MODE === "legacy";
}

export function entityFields<T extends { id: string }>(value: T): Omit<T, "id"> {
  if (legacyStorageWrites()) return value;
  const { id: _id, ...fields } = value;
  return fields;
}
