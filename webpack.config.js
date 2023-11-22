import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import HtmlWebpackPlugin from 'html-webpack-plugin';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = resolve(__dirname, 'src');
const DEST_PATH = resolve(__dirname, 'dist');
const NODE_ENV = process.env.NODE_ENV || 'production';

export default [
    {
        target: 'electron-main',
        mode: NODE_ENV,
        entry: {
            main: resolve(SRC_PATH, 'electron', 'main.ts')
        },
        output: {
            path: resolve(DEST_PATH, 'electron'),
            filename: '[name].bundle.cjs'
        },
        resolve: {
            extensions: ['.ts', '.js'],
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    include: resolve(__dirname, 'src'),
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
                {
                    test: /\.css$/i,
                    use: ['style-loader', 'css-loader', 'postcss-loader'],
                }
            ],
        },
        plugins: [
            new HtmlWebpackPlugin({
                template: resolve(SRC_PATH, 'electron', 'index.html'),
            })
        ]
    },
    {
        target: 'electron-preload',
        mode: NODE_ENV,
        entry: {
            preload: resolve(SRC_PATH, 'electron', 'preload.ts'),
            renderer: resolve(SRC_PATH, 'electron', 'renderer.ts'),
        },
        output: {
            path: resolve(DEST_PATH, 'electron'),
            filename: '[name].bundle.js'
        },
        resolve: {
            extensions: ['.ts', '.js'],
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    include: resolve(__dirname, 'src'),
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
            ],
        }
    }
];