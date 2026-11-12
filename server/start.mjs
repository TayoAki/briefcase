import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.mjs';

const env = process.env;
const port = Number(env.BRIEFCASE_PORT || env.PORT || 4177);
const host = env.BRIEFCASE_HOST || '127.0.0.1';
const origin = env.BRIEFCASE_ORIGIN ? new URL(env.BRIEFCASE_ORIGIN).origin : 'http://127.0.0.1:' + port;
const users = env.BRIEFCASE_USERS_FILE ? JSON.parse(readFileSync(env.BRIEFCASE_USERS_FILE, 'utf8'))
  : env.BRIEFCASE_USERS_JSON ? JSON.parse(env.BRIEFCASE_USERS_JSON) : [{
  username: env.BRIEFCASE_USER || 'lawyer', password: env.BRIEFCASE_PASSWORD,
  firm: 'solo', name: env.BRIEFCASE_LAWYER_NAME || 'Workspace lawyer',
}];
const paperless = env.BRIEFCASE_PAPERLESS_URL || env.BRIEFCASE_PAPERLESS_TOKEN ? {
  base: env.BRIEFCASE_PAPERLESS_URL, token: env.BRIEFCASE_PAPERLESS_TOKEN,
} : undefined;
const model = env.BRIEFCASE_MODEL_URL ? {
  url: new URL(env.BRIEFCASE_MODEL_URL), key: env.BRIEFCASE_MODEL_KEY, model: env.BRIEFCASE_MODEL_NAME,
} : undefined;

if (model && (!['https:', 'http:'].includes(model.url.protocol) || model.url.username || model.url.password || !model.model ||
    (model.url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(model.url.hostname)))) {
  throw new Error('Set BRIEFCASE_MODEL_NAME and an HTTPS completion URL or a loopback HTTP endpoint.');
}
process.umask(0o077);
const portal = env.BRIEFCASE_PORTAL === '1';
if (portal && !['127.0.0.1', '::1', 'localhost'].includes(host) && !origin.startsWith('https://')) {
  throw new Error('Use a loopback listener or a configured HTTPS origin for client portal testing.');
}
const server = buildApp({ database: resolve(env.BRIEFCASE_DB || 'data/briefcase.sqlite'), users, origin, paperless, model, portal,
  workbench: { diligenceKeys: env.BRIEFCASE_DILIGENCE_PUBLIC_KEYS_JSON ? JSON.parse(env.BRIEFCASE_DILIGENCE_PUBLIC_KEYS_JSON) : {} },
  railwayHealth: env.BRIEFCASE_RAILWAY_HEALTH === '1' });
server.listen(port, host, () => console.log('Briefcase is ready at ' + origin));
