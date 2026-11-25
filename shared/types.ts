/** Values in the Forbes feed and snapshots are in US$ millions. */
export interface Person {
  rank: number | null;
  name: string;
  worth: number;
  prevWorth: number | null;
  archivedWorth: number | null;
  country: string | null;
  industry: string | null;
  source: string | null;
  gender: string | null;
  birthDate: number | null;
  selfMade: boolean | null;
  image: string | null;
  annual: Record<string, number>;
}

export interface BillionairesData {
  asOf: number;
  count: number;
  annualYears: number[];
  archivedAsOf: string;
  people: Person[];
}

export interface Snapshot {
  asOf: number;
  people: [name: string, worth: number][];
}

export type History = Record<string, Snapshot>;
export type AnnualLists = Record<string, Record<string, number>>;

export interface ReferenceData {
  updatedAt?: number;
  source?: string;
  worldAdultsM?: number;
  countryAdultsM?: Record<string, number>;
}
