import path from "path";
import { logger } from "../logger";
import { PlainObject } from "../types";
import loadYaml from "./yamlLoader";
import { EventSources, GSDataSourceAsEventSource, GSEventSource } from "./_interfaces/sources";
import expandVariables from "./expandVariables"; // Import the expandVariables function

export default async function (eventsourcesFolderPath: string, datasources: PlainObject): Promise<{ [key: string]: GSEventSource | GSDataSourceAsEventSource }> {
  const eventsourcesConfigs = await loadYaml(eventsourcesFolderPath, false);
  if (eventsourcesConfigs && !Object.keys(eventsourcesConfigs).length) {
    throw new Error(`There are no event sources defined in eventsource dir: ${eventsourcesFolderPath}`);
  }

  const eventSources: EventSources = {};

  for await (let esName of Object.keys(eventsourcesConfigs)) {
    // let's load the event source
    const eventSourceConfig = eventsourcesConfigs[esName];
    logger.debug('evaluating event source %s', esName);
    eventsourcesConfigs[esName] = expandVariables(eventsourcesConfigs[esName]);
    logger.debug(
      'evaluated eventsource %s %o',
      esName,
      eventsourcesConfigs[esName]
    );

    const fileName = eventsourcesConfigs[esName].type;
    try {
      const Module = await import(path.join(eventsourcesFolderPath, 'types', fileName));
      const isPureEventSource = 'initClient' in Module.default.prototype;
      // const isPureEventSource = !!Object.hasOwnProperty.call(Module.default.prototype, 'initClient');
      let eventSourceInstance: GSEventSource | GSDataSourceAsEventSource;

      let Constructor = Module.default;

      if (isPureEventSource) {
        eventSourceInstance = new Constructor(eventsourcesConfigs[esName], datasources) as GSEventSource;
        if ('init' in eventSourceInstance) {
          await eventSourceInstance.init();
        }
      } else {
        let correspondingDatasource = datasources[esName]; // By design, datasource and event source need to share the same name.
        if (!correspondingDatasource) {
          throw new Error(`Corresponding data source for event source ${esName} is not defined. Please ensure a data source type exists with the same file name in /datasources directory`);
        } else {
          eventSourceInstance = new Constructor(eventsourcesConfigs[esName], correspondingDatasource.client) as GSDataSourceAsEventSource;
        }
      }

      eventSources[esName] = eventSourceInstance;
    } catch (error) {
      logger.error(error);
    }
  }

  return eventSources;
};