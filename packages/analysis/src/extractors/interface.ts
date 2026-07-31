import { Entity, Relationship, Language } from '@repo-memory/shared';

export interface ExtractorContext {
  filePath: string;
  content: string;
  language: Language;
}

export interface LanguageExtractor {
  language: Language;
  
  extractNodes(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void;
}
