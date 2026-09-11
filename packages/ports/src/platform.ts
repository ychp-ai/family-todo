export interface Clock {
  now(): Date;
}

export interface UuidGenerator {
  generate(): string;
}
