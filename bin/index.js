import Crawler from '../src/crawler/crawler.js';
import chalk from 'chalk';
import configModel from '../src/models/configModel.js';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';

const configFilePath = path.join('config', 'config.json');
const version = '0.1.0';
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

// Command to create the config file for sasori.
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
      console.error(chalk.red(`Error moving file: ${error}`));
    }
  },
});

// Command to start crawling
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
    } catch (error) {
      console.error(chalk.red(`File "${argv.config}" does not exist: ${error}`));
    }
  },
});

yarg.parse(process.argv.slice(2));
if (process.argv.slice(2).length === 0) {
  // If no command is specified, print the help menu
  yarg.showHelp();
}
