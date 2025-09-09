#!/usr/bin/env node

import Crawler from '../src/crawler/crawler.js';
import chalk from 'chalk';
import { ConfigValidator } from '../src/config/configLoader.js';
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
            if (argv.output) {
                const fullPath = path.resolve(argv.output);
                fs.writeFileSync(fullPath, '');
                value.crawler['outputFile'] = argv.output;
            }
            const crawler = new Crawler(value);
            crawler.startCrawling();
        } catch (err: any) {
            console.error(chalk.red(`[ERROR] ${err.message}`));
        }
    },
});

yarg.parse();
if (process.argv.slice(2).length === 0) {
    // If no command is specified, print the help menu
    yarg.showHelp();
}
