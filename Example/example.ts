import { Boom } from '@hapi/boom'
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast, makeCacheableSignalKeyStore, makeInMemoryStore, MessageRetryMap, useMultiFileAuthState } from '../src'
import MAIN_LOGGER from '../src/Utils/logger'

const logger = MAIN_LOGGER.child({ })
// logger.level = 'trace'
logger.level = 'warn'

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterMap: MessageRetryMap = { }

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = makeInMemoryStore({ logger })
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

function setNonNullable<T>(arg: T): asserts arg is NonNullable<T> {}

// start a connection
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: true,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterMap,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries
		getMessage: async key => {
			if(store) {
				const msg = await store.loadMessage(key.remoteJid!, key.id!)
				return msg?.message || undefined
			}

			// only if store is present
			return {
				conversation: 'hello'
			}
		}
	})

	store?.bind(sock.ev)

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if(connection === 'close') {
					// reconnect if not logged out
					if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')
					}
				}

				if(connection === 'open') {
					void sock.resyncAppState(['regular'], true)
					store.labelsReady().then(() => {
						const labels = store.getLabels()!
						console.log('Available labels:', labels.map((l) => l.name).join(', '))
					})
				}

				console.log('connection update', update)
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
			}

			if(events.call) {
				console.log('recv call event', events.call)
			}

			// received a new message
			if(events['messages.upsert']) {
				const upsert = events['messages.upsert']
				console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

				if(upsert.type === 'notify') {
					for(const msg of upsert.messages) {
						if(msg.key.fromMe) {
							await sock!.readMessages([msg.key])
							const message = msg.message?.conversation
							if(!message || !message.startsWith('/')) {
								continue
							}

							const [cmd, ...args] = message.slice(1).split(' ')
							if(cmd === 'label' || cmd === 'unlabel') {
								const labels = store.getLabels()
								if(!labels) {
									logger.error('Label command', 'Labels not received yet')
									continue
								}

								const isAddingLabel = cmd === 'label'
								const labelName = args.join(' ')
								const labelId = labels.find((l) => l.name === labelName)?.id
								setNonNullable(msg.key.remoteJid)
								if(!labelId) {
									await sock.sendMessage(msg.key.remoteJid, { text: `Label with name ${args} not found, available: ${labels.map((l) => l.name).join(', ')}` })
									continue
								}

								const labelIds = [labelId.toString()]
								await sock.setLabels(msg.key.remoteJid, isAddingLabel ? labelIds : [], isAddingLabel ? [] : labelIds)
							}
						}
					}
				}
			}

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				console.log('messages.update', events['messages.update'])
			}

			if(events['message-receipt.update']) {
				console.log('message-receipt.update', events['message-receipt.update'])
			}

			if(events['messages.reaction']) {
				console.log('messages.reaction', events['messages.reaction'])
			}

			if(events['presence.update']) {
				console.log('presence.update', events['presence.update'])
			}

			if(events['chats.update']) {
				console.log('chats.update', events['chats.update'])
			}

			if(events['contacts.update']) {
				for(const contact of events['contacts.update']) {
					if(typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						console.log(
							`contact ${contact.id} has a new profile pic: ${newUrl}`,
						)
					}
				}
			}

			if(events['chats.delete']) {
				console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock
}

startSock()
