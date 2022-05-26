import express from 'express';
import {GSActor, GSCloudEvent, GSContext, GSFunction, GSParallelFunction, GSSeriesFunction, GSStatus, GSSwitchFunction, GSResponse} from './core/interfaces';

import config from 'config';

import app from './http_listener';
import { config as appConfig } from './core/loader';
import { PlainObject } from './core/common';
import { logger } from './core/logger';

import loadYaml from './core/yamlLoader';
import loadModules from './core/codeLoader';
import { loadFunctions } from './core/functionLoader';
import { JsonnetSnippet, PROJECT_ROOT_DIRECTORY } from './core/utils';

import {loadJsonSchemaForEvents, validateRequestSchema, validateResponseSchema} from './core/jsonSchemaValidation';
import loadDatasources from './core/datasourceLoader';
import KafkaMessageBus from './kafka';

async function loadEvents() {
    logger.info('Loading events');
    const events = await loadYaml(__dirname + '/events', true);
    logger.debug(events,'events');
    logger.info('Loaded events: %s',Object.keys(events));

    loadJsonSchemaForEvents(events);

    return events;
}

function subscribeToEvents(events: any, processEvent:(event: GSCloudEvent)=>Promise<any>) {
    

    //@ts-ignore
    let kafka ;
    
    for (let route in events) {
        let originalRoute = route;

        if (route.includes('.http.')) {
            let method = 'get';

            [route, method] = route.split('.http.');
            route = route.replace(/{(.*?)}/g, ":$1");

            logger.info('registering http handler %s %s', route, method);
            // @ts-ignore
            app[method](route, function(req: express.Request, res: express.Response) {
                logger.debug('originalRoute: %s', originalRoute, req.params, req.files);
                logger.debug('req.params: %s', req.params);
                logger.debug('req.files: %s', req.files);

                const event = new GSCloudEvent('id', originalRoute, new Date(), 'http', '1.0', {
                    body: req.body,
                    params: req.params,
                    query: req.query,
                    headers: req.headers,
                    //@ts-ignore
                    files: Object.values(req.files || {}),
                }, 'REST', new GSActor('user'),  {http: {express:{res}}});
                processEvent(event);
            });
        } else  if (route.includes('.kafka.')) {
            let [topic, groupId] = route.split('.kafka.');
            logger.info('registering kafka handler %s %s', topic, groupId);
            if (!kafka) {
              //@ts-ignore
              logger.info('Creating to kafka bus %o', config.kafka);
              //@ts-ignore
              kafka = new KafkaMessageBus(config?.kafka);
            }
            kafka.subscribe(topic, groupId, processEvent, originalRoute);
        }
    }
}

async function main() {
    logger.info('Main execution');
    let functions:PlainObject;

    const datasources = await loadDatasources(PROJECT_ROOT_DIRECTORY + '/datasources');
    const loadFnStatus = await loadFunctions(datasources,PROJECT_ROOT_DIRECTORY + '/functions');
    if (loadFnStatus.success) {
        functions = loadFnStatus.functions;
    } else {
        logger.error('Unable to load functions exiting...');
        process.exit(1);
    }

    const plugins = await loadModules(__dirname + '/plugins', true);
    const jsonnetSnippet = JsonnetSnippet(plugins);

    logger.debug(plugins,'plugins');

    async function processEvent(event: GSCloudEvent) { //GSCLoudEvent
        logger.debug(events[event.type], event);
        logger.info('Processing event %s',event.type);
        const responseStructure:GSResponse = { apiVersion: (config as any).api_version || "1.0" };

        let valid_status:PlainObject = validateRequestSchema(event.type, event, events[event.type]);

        if(valid_status.success === false)
        {
            logger.error(valid_status, 'Failed to validate Request JSON Schema');
            responseStructure.error = {
                code: valid_status.code,
                message: valid_status.message,
                errors: [ { message: valid_status.message, location: valid_status.data.schemaPath}]
            };
            return (event.metadata?.http?.express.res as express.Response).status(valid_status.code).send(responseStructure);
        }
        logger.info(valid_status, 'Request JSON Schema validated successfully');

         // A workflow is always a series execution of its tasks. I.e. a GSSeriesFunction
        const eventHandlerWorkflow:GSSeriesFunction = <GSSeriesFunction>functions[events[event.type].fn];

        logger.info('calling processevent, type of handler is %s',typeof(eventHandlerWorkflow));

        const ctx = new GSContext(
            config,
            datasources,
            event,
            appConfig.app.mappings,
            jsonnetSnippet,
            plugins
        );

        let eventHandlerStatus; //This will be initialized onthe event when handler errors out, or on its success.
        try {
          // Execute the workflow
          await eventHandlerWorkflow(ctx);
        } catch (err: any) {
          logger.error(`Error in executing handler ${events[event.type].fn} for the event ${event.type}. \n Error message: ${err.message}. \n Error Stack: ${err.stack}`);
          // For non-REST events, we can stop now. Now that the error is logged, nothing more needs to be done.
          if (event.channel !== 'REST') {
            return;
          }
          // Continuining, in case of REST channel, set the status to error mode with proper code and message
          eventHandlerStatus = new GSStatus(
            false, 
            err.code || 500, //Treat as internal server error by default
            `Error in executing handler ${events[event.type].fn} for the event ${event.type}`, 
            err //status data
          );
        }
        /**
         * For non-rest events, stop now. Nothing more needs to be done.
         * For REST events check the response schema. If OK, 
         * send the status data over the wire to the caller. Else send response validation error.
        **/

       // Continue further only for REST events, whether or not handler executed successfully.
        if (event.channel !== 'REST') {
          return;
        } 

        //Continuing for REST events: to validate the handler response and send the HTTP response

        //eventHandlerStatus being undefined means there was no error. Because on error, 
        //we are initializing the eventHandlerStatus with the error data, in the catch block above.
        const successfulExecution = !eventHandlerStatus;
        if (successfulExecution) { // Means no error happened

          // The final status of the handler workflow is calculated from the last task of the handler workflow (series function)
          eventHandlerStatus = ctx.outputs[eventHandlerWorkflow.id];
          if (eventHandlerStatus.success) {
            // Check the handler's reponse data now, against the event's response schema

            valid_status = validateResponseSchema(event.type, eventHandlerStatus);

            if (valid_status.success) {
                logger.info(valid_status, 'Validate Response JSON Schema Success');
            } else {
                logger.error(valid_status, 'Validate Response JSON Schema Error');
                // Reinitialize eventHandlerStatus with data for response validation erro
                eventHandlerStatus = new GSStatus(false, 500, 'Internal server error. Server created wrong response object, not compatible with the event\'s response schema.');
            }
          }
        }
        
        //Now send the actual response over REST, for both the success and failure scenarios
        if (eventHandlerStatus?.success) {
            logger.debug(eventHandlerStatus, 'Request Successful End');
            responseStructure.data = {
                items: [ eventHandlerStatus?.data ]
            };
            (event.metadata?.http?.express.res as express.Response).status(eventHandlerStatus?.code || 200).send(responseStructure);
        } else {
            logger.error(eventHandlerStatus, 'Response Error End');
            responseStructure.error = {
                code: eventHandlerStatus?.code ?? 500,
                message: eventHandlerStatus?.message,
                errors: [ eventHandlerStatus?.data ]
            };
            (event.metadata?.http?.express.res as express.Response).status(eventHandlerStatus?.code ?? 500).send(responseStructure);
        }
    }

    const events = await loadEvents();
    subscribeToEvents(events, processEvent);
}

main();
