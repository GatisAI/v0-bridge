import {handle} from '../src/app.js';
// Vercel Node.js Web Standard handler. Secrets are server-only environment values.
export default {fetch:request=>handle(request,process.env)};
