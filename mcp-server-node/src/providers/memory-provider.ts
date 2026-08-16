import type { MemoryNode, SearchData } from "../types.js";

export interface SaveInput {
  cubeId: string;
  content: string;
  memoryType: string;
  tags?: string[];
  confidence?: number;
  status?: string;
  source?: string;
  sessionId?: string;
  sourceRef?: string;
}

export interface MemoryProvider {
  save(input: SaveInput): Promise<MemoryNode>;
  get(cubeId: string, memoryId: string): Promise<MemoryNode | null>;
  list(cubeId: string, limit: number, memoryType?: string): Promise<MemoryNode[]>;
  search(cubeId: string, query: string, topK: number): Promise<MemoryNode[]>;
  recent(cubeId: string, sinceHours: number, limit: number): Promise<MemoryNode[]>;
  toSearchData(cubeId: string, nodes: MemoryNode[]): SearchData;
}
