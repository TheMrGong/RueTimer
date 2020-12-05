import chalk, { ChalkFunction } from "chalk"
import moment from "moment"

interface ConsoleEmitter {
    (message?: any, ...optionalParamters: any[]): void
}

const colors: { [key: string]: ChalkFunction } = {
    "info": chalk.green,
    "error": chalk.red,
    "warn": chalk.yellow,
    "debug": chalk.blue
}

for (const adapterName of Object.keys(colors)) {
    const colorize = colors[adapterName]
    //@ts-ignore
    const originalEmitter: ConsoleEmitter = console[adapterName]
    if (originalEmitter) {
        //@ts-ignore

        console[adapterName] = (message?: any, ...optionalParamters?: any[]) => {
            const msgPrefix = `${process.pid} - ${chalk.grey(moment().format("YYYY-MM-DD HH:mm:ss +SSS"))} ${colorize(adapterName.toUpperCase())} `

            if (optionalParamters && optionalParamters.length > 0)
                originalEmitter(msgPrefix + message + "\n", ...optionalParamters)
            else originalEmitter(msgPrefix, message)
        }
    }
}
//if (process.env.NODE_ENVIRONMENT !== "development") console["debug"] = () => { }

console["log"] = console["debug"]
