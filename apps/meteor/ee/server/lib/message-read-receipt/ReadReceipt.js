import { Random } from '@rocket.chat/random';
import { LivechatVisitors, ReadReceipts, Messages, Rooms, Subscriptions } from '@rocket.chat/models';

import { Users } from '../../../../app/models/server';
import { settings } from '../../../../app/settings/server';
import { SystemLogger } from '../../../../server/lib/logger/system';
import { roomCoordinator } from '../../../../server/lib/rooms/roomCoordinator';

// debounced function by roomId, so multiple calls within 2 seconds to same roomId runs only once
const list = {};
const debounceByRoomId = function (fn) {
	return function (roomId, ...args) {
		clearTimeout(list[roomId]);
		list[roomId] = setTimeout(() => {
			fn.call(this, roomId, ...args);
			delete list[roomId];
		}, 2000);
	};
};

const updateMessages = debounceByRoomId(async ({ _id, lm }) => {
	// @TODO maybe store firstSubscription in room object so we don't need to call the above update method
	const firstSubscription = await Subscriptions.getMinimumLastSeenByRoomId(_id);
	if (!firstSubscription || !firstSubscription.ls) {
		return;
	}

	await Messages.setVisibleMessagesAsRead(_id, firstSubscription.ls);

	if (lm <= firstSubscription.ls) {
		await Rooms.setLastMessageAsRead(_id);
	}
});

export const ReadReceipt = {
	async markMessagesAsRead(roomId, userId, userLastSeen) {
		if (!settings.get('Message_Read_Receipt_Enabled')) {
			return;
		}

		const room = await Rooms.findOneById(roomId, { projection: { lm: 1 } });

		// if users last seen is greater than room's last message, it means the user already have this room marked as read
		if (!room || userLastSeen > room.lm) {
			return;
		}

		this.storeReadReceipts(await Messages.findVisibleUnreadMessagesByRoomAndDate(roomId, userLastSeen).toArray(), roomId, userId);

		await updateMessages(room);
	},

	async markMessageAsReadBySender(message, { _id: roomId, t }, userId) {
		if (!settings.get('Message_Read_Receipt_Enabled')) {
			return;
		}

		if (!message.unread) {
			return;
		}

		// mark message as read if the sender is the only one in the room
		const isUserAlone = (await Subscriptions.countByRoomIdAndNotUserId(roomId, userId)) === 0;
		if (isUserAlone) {
			await Messages.setAsReadById(message._id);
		}

		const extraData = roomCoordinator.getRoomDirectives(t).getReadReceiptsExtraData(message);
		this.storeReadReceipts([{ _id: message._id }], roomId, userId, extraData);
	},

	async storeThreadMessagesReadReceipts(tmid, userId, userLastSeen) {
		if (!settings.get('Message_Read_Receipt_Enabled')) {
			return;
		}

		const message = await Messages.findOneById(tmid, { projection: { tlm: 1, rid: 1 } });

		// if users last seen is greater than thread's last message, it means the user has already marked this thread as read
		if (!message || userLastSeen > message.tlm) {
			return;
		}

		this.storeReadReceipts(await Messages.findUnreadThreadMessagesByDate(tmid, userId, userLastSeen).toArray(), message.rid, userId);
	},

	async storeReadReceipts(messages, roomId, userId, extraData = {}) {
		if (settings.get('Message_Read_Receipt_Store_Users')) {
			const ts = new Date();
			const receipts = messages.map((message) => ({
				_id: Random.id(),
				roomId,
				userId,
				messageId: message._id,
				ts,
				...extraData,
			}));

			if (receipts.length === 0) {
				return;
			}

			try {
				await ReadReceipts.insertMany(receipts);
			} catch (err) {
				SystemLogger.error({ msg: 'Error inserting read receipts per user', err });
			}
		}
	},

	async getReceipts(message) {
		const receipts = await ReadReceipts.findByMessageId(message._id).toArray();

		return Promise.all(
			receipts.map(async (receipt) => ({
				...receipt,
				user: receipt.token
					? await LivechatVisitors.getVisitorByToken(receipt.token, { projection: { username: 1, name: 1 } })
					: Users.findOneById(receipt.userId, { fields: { username: 1, name: 1 } }),
			})),
		);
	},
};
