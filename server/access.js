import { UserError } from './util.js';

/** What a browser user may do over the WebSocket – only on the identities assigned to them. */
const BROWSER_ACTIONS = new Set([
  'hello', 'browsers.view', 'browsers.input', 'browsers.nav', 'browsers.tab', 'browsers.fack', 'browsers.stream',
  'browsers.resize', 'browsers.dialog', 'browsers.fedcm', 'browsers.files', 'browsers.start', 'browsers.stop', 'browsers.audio', 'browsers.mic',
]);
/** Broadcasts a browser user receives (everything else – projects, sessions, usage, logins – stays with the admin). */
const BROWSER_BROADCASTS = new Set(['ack', 'hello', 'config', 'browsers', 'bframe', 'bstate', 'bstats', 'bdialog', 'bfedcm', 'bfile', 'bnotice', 'bmedia']);

/**
 * Roles: "admin" (the cockpit password) may do everything; "browser" users (data/users.json) only drive
 * the browser identities the admin assigned to them, through their own page /u/<name>.
 */
export function createAccess(ctx) {
  const users = () => ctx.security.users;
  const browsersOf = (name) => users().get(name)?.browsers ?? [];

  const access = {
    /** Role facts for a hub client (set at connect, refreshed per call so changes apply at once). */
    describe(client) {
      if (!client.user) return { role: 'admin', name: ctx.security.adminName(), browsers: null };
      return { role: 'browser', name: client.user, browsers: browsersOf(client.user) };
    },
    canUseBrowser(session, id) {
      if (!session?.user) return !!session;
      return browsersOf(session.user).includes(id);
    },
    /** Throws unless this client may run this action. */
    check(msg, client) {
      if (!client.user) return;
      if (!BROWSER_ACTIONS.has(msg.t)) throw new UserError('Kein Zugriff');
      if (msg.t !== 'hello' && !browsersOf(client.user).includes(String(msg.id))) throw new UserError('Kein Zugriff auf diesen Browser');
    },
    /** What of a broadcast reaches this client: the message, a reduced copy or nothing. */
    filter(client, obj) {
      if (!client.user) return obj;
      if (!BROWSER_BROADCASTS.has(obj.t)) return null;
      const mine = browsersOf(client.user);
      if (obj.profileId && !mine.includes(obj.profileId)) return null;
      if (obj.t === 'browsers') return { ...obj, browsers: { ...obj.browsers, profiles: obj.browsers.profiles.filter((p) => mine.includes(p.id)), status: {} } };
      return obj;
    },
  };
  return access;
}
