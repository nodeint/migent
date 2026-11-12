import { ARGV_USER_OFFSET } from '@nodeint/migent-kernel';

import { childMain } from './child.js';

const code = await childMain(process.argv.slice(ARGV_USER_OFFSET));
process.exit(code);
