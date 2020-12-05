import "./util/injectlogger"
import Discord from "discord.js"
import dotenv from "dotenv"
import prettyMs from "pretty-ms"

const PREFIX = "!"
const STOP_TEXTS = ["cancel", "stop", "end"]
const STATUS_TEXTS = ["status", "current"]
const MAX_TIME = 1000 * 60 * 60 * 24
const REMINDERS_EVERY = [// 10 seconds, 1 minute, 5 minutes, 30 minutes, every hour after
    60 * 60,
    60 * 30,
    60 * 10,
    60 * 5,
    60,
    30,
    10,
    5
]

dotenv.config()

type ScheduledTimer = {
    end: number,
    scheduler: Discord.Snowflake,
    lastReminder: number,
    lastReminderId?: Discord.Snowflake,
    invalidScheduler?: boolean
}

const client = new Discord.Client()
const scheduled: {
    [guildId: string]: {
        [channelId: string]: ScheduledTimer
    }
} = {}

client.on("message", (msg) => {
    if (msg.author.bot || !msg.guild || msg.reference || !msg.content.startsWith(PREFIX)) {
        return
    }
    const guild = msg.guild
    const channel = msg.channel
    if (!(channel instanceof Discord.TextChannel)) {
        return
    }
    const components = msg.content.split(" ")
    const cmd = components[0].substring(PREFIX.length).toLowerCase()
    const args = components.slice(1, components.length)


    switch (cmd) {
        case "timer":
            timerCommand(msg, guild, args)
                .catch((e) => {
                    replyTo(msg, `Unknown error occurred running timer command`).catch((e) => {
                        console.error(`Couldn't reply error with timer command`)
                        console.error(e)
                    })
                    console.error(`Unexpected error running timer for ${msg.author} with args '${args.join(" ")}'`)
                    console.error(e)
                })
            break
        default:
            break
    }

})

async function timerCommand(msg: Discord.Message, guild: Discord.Guild, args: string[]) {
    let guildTimers = scheduled[guild.id]

    if (args.length == 0) {
        let reply = `Usage: ${PREFIX}timer <seconds | cancel>`
        if (guildTimers && guildTimers[msg.channel.id]) {
            reply += `\n${await getTimerStatus(guild, msg.author, guildTimers[msg.channel.id])}`
        }
        return replyTo(msg, reply)
    }

    const arg = args[0].toLowerCase()
    if (STOP_TEXTS.includes(arg)) {
        if (!guildTimers || !guildTimers[msg.channel.id]) {
            return replyTo(msg, `No current timer in this channel`)
        }

        const timer = guildTimers[msg.channel.id]
        const name = await getTimerScheduler(guild, msg.author, timer)
        await replyTo(msg, `Cancelled ${name} in this channel - it had ${formatTimerRemaining(timer)} remaining`)
        delete guildTimers[msg.channel.id]
        return
    } else if (STATUS_TEXTS.includes(arg)) {
        if (!guildTimers || !guildTimers[msg.channel.id]) {
            return replyTo(msg, `No current timer in this channel`)
        }
        const timer = guildTimers[msg.channel.id]
        return replyTo(msg, await getTimerStatus(guild, msg.author, timer))
    }
    const timeInput = parseInt(arg)
    if (isNaN(timeInput)) {
        return replyTo(msg, `Time needs to be a number`)
    }
    if (timeInput <= 0) {
        return replyTo(msg, `Cannot have a negative timer`)
    }
    const time = timeInput * 1000

    if (time >= MAX_TIME) {
        return replyTo(msg, `Cannot have a timer longer than ${prettyMs(MAX_TIME, {
            verbose: true
        })}`)
    }

    if (!guildTimers) {
        guildTimers = scheduled[guild.id] = {}
    }

    let prefix = ""
    if (guildTimers[msg.channel.id]) {
        const timer = guildTimers[msg.channel.id]
        const name = await getTimerScheduler(guild, msg.author, timer)
        prefix = `**-** Cancelled ${name} in this channel - it had ${formatTimerRemaining(timer)} remaining\n`
        delete guildTimers[msg.channel.id]
    }

    await replyTo(msg, `${prefix}Started timer for ${prettyMs(time)}`)
    guildTimers[msg.channel.id] = {
        end: Date.now() + time,
        scheduler: msg.author.id,
        lastReminder: Date.now()
    }
}

async function getTimerScheduler(guild: Discord.Guild, asking: Discord.User, timer: ScheduledTimer, capitilize = false): Promise<string> {
    if (asking.id == timer.scheduler) {
        return `${capitilize ? "Y" : "y"}our timer`
    }
    let user: Discord.User | undefined
    let displayName: string | undefined

    try {
        user = await client.users.fetch(timer.scheduler)
    } catch (e) {
        console.warn(`Failed to get timer's scheduler user ${timer.scheduler}: ` + e)
    }

    if (user) {
        try {
            displayName = (await guild.members.fetch(user))?.displayName
        } catch (e) {
            console.warn(`Failed to get timer's scheduler guild member ${timer.scheduler}: ` + e)
        }
    }

    const name = displayName || "Unknown User"
    return `\`${name}\`'s timer`
}

async function getTimerStatus(guild: Discord.Guild, asking: Discord.User, timer: ScheduledTimer) {
    return `${await getTimerScheduler(guild, asking, timer, true)} is currently running with ${formatTimerRemaining(timer)} remaining`
}

async function handleTimerTick() {
    for (const guildId in scheduled) {
        let guild: Discord.Guild | undefined
        try {
            guild = await client.guilds.fetch(guildId)
        } catch (e) {
            console.warn(`Failed to fetch guild ${guildId} for timers`)
        }
        if (!guild) {
            console.warn(`Removing guild ${guildId}, couldn't find it`)
            delete scheduled[guildId]
            continue
        }

        const guildTimers = scheduled[guildId]

        for (const channelId in guildTimers) {
            const timer = guildTimers[channelId]
            let channel: Discord.TextChannel | undefined
            try {
                const discordChannel = await guild.channels.resolve(channelId)
                if (discordChannel instanceof Discord.TextChannel) {
                    channel = discordChannel
                }
            } catch (e) {
                console.warn(`Failed to fetch channel '${channelId}' for guild '${guild.name}'`)
            }
            if (!channel) {
                console.warn(`Cancelling channel timer '${channelId}' for guild '${guild.name}', couldn't find channel`)
                delete guildTimers[channelId]
                continue
            }
            let schedulerTag: string | undefined
            let scheduledName: string | undefined
            if (!timer.invalidScheduler) try {
                const user = await client.users.fetch(timer.scheduler)
                schedulerTag = user?.toString()

                if (user) {
                    scheduledName = (await guild.members.fetch(user))?.displayName || user.username
                }
            } catch (e) {
                console.warn(`Failed to get scheduler for timer in channel '${channel.name}' guild '${guild.name}' with id '${timer.scheduler}': ` + e)
                timer.invalidScheduler = true
            }
            if (!schedulerTag) {
                schedulerTag = `Unknown user`
            }
            if (!scheduledName) {
                scheduledName = `Unknown user`
            }

            const failedSend = (e: any) => {
                console.warn(`Failed to send a message in channel '${channel?.name}'`)
                console.warn(e)
                return undefined
            }

            if (Date.now() >= timer.end) {
                await tryRemoveTimerReminder(channel, timer)
                await channel.send(`${schedulerTag}, your timer in this channel has ended!`).catch(failedSend)
                delete guildTimers[channelId]
                if (Object.keys(guildTimers).length === 0) {
                    delete scheduled[guildId]
                }
            } else {
                const secondsRemaining = Math.round((timer.end - Date.now()) / 1000)
                const interval = REMINDERS_EVERY.find((interval) => secondsRemaining % interval === 0 && interval >= secondsRemaining)
                    || REMINDERS_EVERY[0]

                if (secondsRemaining && secondsRemaining % interval === 0 && Date.now() - timer.lastReminder > 1000) {
                    timer.lastReminder = Date.now()
                    await tryRemoveTimerReminder(channel, timer)

                    const reminder = await channel.send(`\`${scheduledName}\`, your timer in this channel has ${formatTimerRemaining(timer)} remaining`)
                        .catch(failedSend)
                    timer.lastReminderId = reminder?.id
                }
            }
        }
    }
}

async function tryRemoveTimerReminder(channel: Discord.TextChannel, timer: ScheduledTimer) {
    if (!timer.lastReminderId) {
        return
    }
    try {
        const clientMember = client.user && await channel.guild.members.fetch(client.user).catch(e => e + "")
        if (!clientMember || typeof clientMember == "string") {
            throw new Error(`Failed to get client member: ${clientMember}`)
        }
        const msg = await channel.messages.fetch(timer.lastReminderId)
        if (msg && channel.permissionsFor(clientMember)?.has("MANAGE_MESSAGES")) {
            await msg.delete().catch((e) => {
                console.warn(`Failed to remove previous reminder: ` + e)
            })
        }
    } catch (e) {
        console.warn(`Unable to delete last reminder for guild '${channel.guild.id}' channel ${channel.id} message ${timer.lastReminderId}: ` + e)
    }
}

function doTimerTicking() {
    const handlingStart = Date.now()
    handleTimerTick().catch((e) => {
        console.error(`Uncaught error in timer`)
        console.error(e)
    }).then(() => {
        const timeSinceTick = Date.now() - handlingStart
        setTimeout(doTimerTicking, Math.max(0, 50 - timeSinceTick))
    })
}

function formatTimerRemaining(timer: ScheduledTimer) {
    const timeRemaining = Math.round((timer.end - Date.now()) / 1000) * 1000
    return prettyMs(Math.max(0, timeRemaining))
}

async function start() {
    await client.login(process.env.BOT_TOKEN)
    doTimerTicking()
}

async function replyTo(msg: Discord.Message, content: string) {
    const channel = msg.channel
    if (!(channel instanceof Discord.TextChannel)) {
        return
    }
    const apiMsg = Discord.APIMessage.create(channel, content)
    await apiMsg.resolveData()

    //@ts-ignore
    apiMsg.data.message_reference = {
        message_id: msg.id,
        guild_id: channel.guild.id
    }

    channel.send(apiMsg)
}

start().then(() => {
    console.info("Bot started")
}).catch((e) => {
    console.error("Failed to start bot")
    console.error(e)
    process.exit(-1)
})