#!/usr/bin/env node

import Crawler from '../src/crawler/crawler.js';
import chalk from 'chalk';
import { ConfigValidator } from '../src/config/configLoader.js';
import { startApiServer } from '../src/api/startApiServer.js';
import { setupLogging } from '../src/logger/logger.js';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { version } from '../package.json';

const configFilePath = path.join(__dirname, '..', 'config', 'config.json');
const banner = `
                              :.            :   
                             .+              =. 
                             ++.            .-= 
                            :++==   .  .   :===:
                            -+++.   :  :    =++-
                              ==    .--.   .-=. 
                               :+: .-:.-. :=:   
                             .-::--:-::::--:::. 
                            -: .:-..::::..::. :-
                            - ::  ..:::: :  :: -
                              -  -. :--: .-  -  
                              :  -   --.  :. :  
                                 :   ..   :     

                                   SASORI

                            Made by @5up3r541y4n 🔥

                                   v${version}

`;

console.log(chalk.greenBright.bold(banner));

const yarg = yargs(hideBin(process.argv));
yarg.usage('Usage: sasori [command]');
yarg.version(version);

/**
 * Command to create the config file for sasori.
 */
yarg.command({
    command: 'init',
    describe: 'Create a configuration file for sasori',
    handler(_argv: any) {
        try {
            const fileName = path.basename(configFilePath);
            const configContent = fs.readFileSync(configFilePath);
            const destinationPath = path.join(process.cwd(), fileName);
            fs.writeFileSync(destinationPath, configContent);

            console.log(chalk.green(`[INFO] Config file created at: ${destinationPath}`));
        } catch (error: any) {
            console.error(chalk.red(`[ERROR] Error creating configuration file: ${error}`));
        }
    },
});

/**
 * Command to start crawling.
 */
yarg.command({
    command: 'start',
    describe: 'Start crawling',
    builder: {
        config: {
            alias: 'c',
            describe: 'Config file for sasori',
            demandOption: true,
            type: 'string',
        },
        output: {
            alias: 'o',
            describe: 'Output file for the list of URLs',
            demandOption: false,
            type: 'string',
        },
        inventory: {
            alias: 'i',
            describe: 'Output file for the crawl inventory (endpoints and DOM states reached, JSON)',
            demandOption: false,
            type: 'string',
        },
        'crawl-graph': {
            alias: 'g',
            describe: 'Output file for the crawl graph (states + action edges + status, JSON; .mmd/.dot siblings written too)',
            demandOption: false,
            type: 'string',
        },
    },
    handler(argv: any) {
        try {
            fs.accessSync(argv.config, fs.constants.F_OK);
            console.log(chalk.green(`[INFO] Config file "${argv.config}" exists.`));
            const config = JSON.parse(fs.readFileSync(argv.config, 'utf-8'));
            let value;
            try {
                value = ConfigValidator.validate(config);
                // ConfigValidator.validate throws on error, so if we get here, config is valid
            } catch (error: any) {
                console.error(chalk.red(`[ERROR] ${error.message}`));
                return;
            }
            // Tee console output to the configured rotating log file (SCAN-181).
            setupLogging(value.logging);
            if (argv.output) {
                const fullPath = path.resolve(argv.output);
                fs.writeFileSync(fullPath, '');
                value.crawler['outputFile'] = argv.output;
            }
            if (argv.inventory) {
                // Not truncated up front the way the URL list is: the inventory
                // is written once, whole, at the end of the crawl, so emptying
                // it here would only destroy a previous run's artifact if this
                // crawl failed to start.
                value.crawler['inventoryFile'] = argv.inventory;
            }
            if (argv['crawlGraph']) {
                // Same rationale as the inventory: written once, whole, at the
                // end of the crawl, so it is not emptied up front.
                value.crawler['crawlGraphFile'] = argv['crawlGraph'];
            }
            const crawler = new Crawler(value);
            crawler.startCrawling();
        } catch (err: any) {
            console.error(chalk.red(`[ERROR] ${err.message}`));
        }
    },
});

/**
 * Run HTTP API server for concurrent scans (POST config per scan).
 */
yarg.command({
    command: 'api',
    describe: 'Start REST API server for multiple concurrent scans',
    builder: {
        host: {
            describe: 'Bind address',
            type: 'string',
            default: '0.0.0.0',
        },
        port: {
            describe: 'Listen port',
            type: 'number',
            default: 8080,
        },
    },
    async handler(argv: any) {
        try {
            // The API takes a crawler config per scan, but logging is process-wide,
            // so configure it once at startup from the default config file's
            // `logging` block (best-effort — absent/invalid file = stdout only).
            try {
                const raw = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
                setupLogging(raw?.logging);
            } catch {
                /* no default config / no logging block — keep stdout only */
            }

            const { port, host } = await startApiServer({ host: argv.host as string, port: argv.port as number });
            console.log(
                chalk.greenBright(
                    `[INFO] Sasori API listening on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port} (bound ${host}:${port})`,
                ),
            );
            console.log(chalk.cyan('  POST   /api/v1/scans   — start scan (JSON body = crawler config)'));
            console.log(chalk.cyan('  GET    /api/v1/scans   — list scans'));
            console.log(chalk.cyan('  GET    /api/v1/scans/:id'));
            console.log(chalk.cyan('  DELETE /api/v1/scans/:id — stop scan'));
            console.log(chalk.cyan('  GET    /health'));
        } catch (err: unknown) {
            console.error(chalk.red(`[ERROR] ${err instanceof Error ? err.message : err}`));
            process.exitCode = 1;
        }
    },
});

yarg.parse();
if (process.argv.slice(2).length === 0) {
    // If no command is specified, print the help menu
    yarg.showHelp();
}
