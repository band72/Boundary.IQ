import 'dotenv/config';
import * as dbSvc from '../services/diagnosticsDb.js';

dbSvc.init();
// We can't access dbPath directly unless we inspect the module or replicate the logic,
// but let's print the env variables:
console.log('--- DATABASE PATH INFO ---');
console.log('process.env.DATABASE_PATH:', process.env.DATABASE_PATH);
console.log('process.env.DB_PATH:', process.env.DB_PATH);
console.log('process.env.DIAGNOSTICS_DB_PATH:', process.env.DIAGNOSTICS_DB_PATH);
console.log('XDG_CONFIG_HOME:', process.env.XDG_CONFIG_HOME);
console.log('--------------------------');
