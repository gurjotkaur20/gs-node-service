/*
* You are allowed to study this software for learning and local * development purposes only. Any other use without explicit permission by Mindgrep, is prohibited.
* © 2022 Mindgrep Technologies Pvt Ltd
*/
import Pino from 'pino';
import config from 'config';
import { getAtPath } from '../core/utils';
const conf = config as any;

const configRedact = conf.redact || conf.log?.redact || [];
let redactAttrs: Array<string> = [];
for (const redactAttr of configRedact) {
  if (redactAttr.match(/^\*\*/)) {
    const fieldName = redactAttr.replace(/^\*\*\./, '');
    redactAttrs.push(`${fieldName}`,
      `*.${fieldName}`,
      `*.*.${fieldName}`,
      `*.*.*.${fieldName}`,
      `*.*.*.*.${fieldName}`,
      `*.*.*.*.*.${fieldName}`,
      `*.*.*.*.*.*.${fieldName}`,
      `*.*.*.*.*.*.*.${fieldName}`,
      `*.*.*.*.*.*.*.*.${fieldName}`,
      `*.*.*.*.*.*.*.*.*.${fieldName}`
    );
  } else {
    redactAttrs.push(redactAttr);
  }
}

let logTarget: string;
if (process.env.OTEL_ENABLED == 'true' && process.env.NODE_ENV != 'dev') {
  logTarget = "../pino/pino-opentelemetry-transport.js";
} else {
  logTarget = "pino-pretty";
}
let timestampSetting;
if (conf.log?.timestamp) {
  timestampSetting = getAtPath(Pino, conf.log.timestamp);
}
const logger: Pino.Logger = Pino({
  level: conf.log?.level || conf.log_level || 'info',
  //@ts-ignore
  timestamp: timestampSetting,
  formatters: {
    bindings: (bindings) => {
      if (!conf.log?.bindings?.pid) {
        delete bindings.pid;
      }
      if (!conf.log?.bindings?.hostname) {
        delete bindings.hostname;
      }
      return bindings;
    }
  },
  transport: {
    target: logTarget,
    options: {
      destination: 1,
      sync: conf.log?.sync,
      Resource: {
        'service.name': process.env.OTEL_SERVICE_NAME || 'unknown_service:node',
        env: process.env.NODE_ENV
      }
    }
  },
  redact: {
    paths: redactAttrs,
    censor: '*****'
  }
});
// process.on('exit', () => {console.log('hesdfasfasfasfasdfasdfasfasdfasdfasdf')});  //logger.flushSync()})
export { logger };
