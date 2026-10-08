import type { Migration } from './runner.js';
import { migration001 } from './001-init.js';
import { migration002 } from './002-repo-path-scoping.js';
import { migration003 } from './003-embeddings.js';
import { migration004 } from './004-id-lengths.js';
import { migration005 } from './005-commit-repo-scoping.js';
import { migration006 } from './006-entity-repo-scoping.js';
import { migration007 } from './007-embedding-provider.js';

export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
];
