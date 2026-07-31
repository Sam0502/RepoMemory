import { Language } from '@repo-memory/shared';
import { TypeScriptExtractor } from './typescript.js';

export class JavaScriptExtractor extends TypeScriptExtractor {
  language = Language.JAVASCRIPT;
}
