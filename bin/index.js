#!/usr/bin/env node

const Crawler = require('../src/crawler/crawler.js');
const chalk = require('chalk');
const configModel = require('../src/models/configModel.js');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs');
const {version} = require('../package.json');

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

const yarg = yargs();
yarg.usage('Usage: sasori [command]');
yarg.version(version);

/**
 * Command to create the config file for sasori.
 */
yarg.command({
  command: 'init',
  describe: 'Create a configuration file for sasori',
  handler(argv) {
    try {
      const fileName = path.basename(configFilePath);
      const configContent = fs.readFileSync(configFilePath);
      const destinationPath = path.join(process.cwd(), fileName);
      fs.writeFileSync(destinationPath, configContent);

      console.log(chalk.green(`[INFO] Config file created at: ${destinationPath}`));
    } catch (error) {
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
      describe: 'Config file for sasori',
      demandOption: true,
      type: 'string',
    },
  },
  handler(argv) {
    try {
      fs.accessSync(argv.config, fs.constants.F_OK);
      console.log(chalk.green(`[INFO] Config file "${argv.config}" exists.`));
      const config = JSON.parse(fs.readFileSync(argv.config, 'utf-8'));
      const {error, value} = configModel.validate(config);
      if (error) {
        console.error(chalk.red(`[ERROR] ${error.message}`));
        return;
      }
      const crawler = new Crawler(value);
      crawler.startCrawling();
    } catch (err) {
      console.error(chalk.red(`[ERROR] ${err.message}`));
    }
  },
});

yarg.parse(process.argv.slice(2));
if (process.argv.slice(2).length === 0) {
  // If no command is specified, print the help menu
  yarg.showHelp();
}
