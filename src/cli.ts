#!/usr/bin/env bun
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import { runMcp } from './mcp.ts';
import { startServer } from './server.ts';
import { absDir, lockMap, readInstances, registerInstance, token } from './store.ts';

const USAGE = `eda — a mind map you grow one node at a time with an AI that can only suggest

  eda serve <dir> [--title <t>] [--host 0.0.0.0] [--port 0]   start the map in <dir> (created if missing)
  eda list                                                    running maps
  eda mcp                                                     MCP server + channel, spawned by Claude Code
  eda token                                                   the token the browser asks for`;

/** The address a person on the LAN can open. Docker bridges are never it. */
function lanIp(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) return a.address;
    }
  }
  return '127.0.0.1';
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'serve': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { title: { type: 'string' }, host: { type: 'string', default: '0.0.0.0' }, port: { type: 'string', default: '0' } },
      });
      if (positionals.length !== 1) {
        console.error(USAGE);
        return 2;
      }
      const dir = absDir(positionals[0]!);
      const release = lockMap(dir);
      if (typeof release === 'number') {
        const other = readInstances().find((i) => i.pid === release);
        console.error(`eda: ${dir} is already served by pid ${release}${other ? ` on port ${other.port}` : ''}`);
        return 1;
      }
      const session = process.env['CLAUDE_CODE_SESSION_ID'] || undefined;
      const { server } = startServer({
        dir,
        host: values.host!,
        port: Number(values.port),
        ...(values.title === undefined ? {} : { title: values.title }),
        ...(session === undefined ? {} : { session }),
        cwd: process.cwd(),
      });
      const unregister = registerInstance({
        pid: process.pid,
        dir,
        host: values.host!,
        port: server.port!,
        ...(session === undefined ? {} : { session }),
        startedAt: new Date().toISOString(),
      });
      const stop = (): void => {
        unregister();
        release();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      const host = values.host === '0.0.0.0' ? lanIp() : values.host;
      console.log(JSON.stringify({ url: `http://${host}:${server.port}/#t=${token()}`, dir, port: server.port, pid: process.pid }));
      return await new Promise<number>(() => {});
    }
    case 'list':
      for (const i of readInstances()) console.log(`${i.pid}\t${i.port}\t${i.session ?? '-'}\t${i.dir}`);
      return 0;
    case 'mcp':
      await runMcp();
      return await new Promise<number>(() => {});
    case 'token':
      console.log(token());
      return 0;
    default:
      console.error(USAGE);
      return cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2;
  }
}

process.exit(await main(process.argv.slice(2)));
