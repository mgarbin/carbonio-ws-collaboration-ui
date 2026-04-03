/*
 * SPDX-FileCopyrightText: 2024 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import VideoScreenInConnection from './VideoScreenInConnection';
import useStore from '../../store/Store';
import {
	createMockMeeting,
	createMockMember,
	createMockParticipants,
	createMockRoom,
	createMockUser
} from '../../tests/createMock';
import { STREAM_TYPE } from '../../types/store/ActiveMeetingTypes';
import { User } from '../../types/store/UserTypes';
import { mockFetchAPI } from '../../utils/__mocks__/FetchUtils';

vi.mock('../../utils/FetchUtils');

const user1Info: User = createMockUser({ id: 'user1', email: 'user1@domain.com', name: 'User 1' });
const groupRoom = createMockRoom({
	id: 'room-test',
	members: [
		createMockMember({ userId: 'user1', owner: true }),
		createMockMember({ userId: 'user2' })
	]
});
const groupMeeting = createMockMeeting({
	roomId: groupRoom.id,
	participants: [
		createMockParticipants({ userId: 'user1', videoStreamEnabled: true }),
		createMockParticipants({ userId: 'user2', videoStreamEnabled: true })
	]
});

// Build a fake MediaStream with a given userId/type ID (matching the SFU convention).
const buildRemoteStream = (userId: string, type: STREAM_TYPE): MediaStream => {
	const stream = {
		id: `${userId}/${type}`,
		active: true,
		getTracks: vi.fn(() => []),
		getVideoTracks: vi.fn(() => [])
	};
	return stream as unknown as MediaStream;
};

// Build a minimal RTCTrackEvent.
const buildTrackEvent = (
	streams: MediaStream[],
	onunmuteCapture?: { ref: ((...args: unknown[]) => void) | null }
): RTCTrackEvent => {
	const track = {
		kind: 'video',
		id: 'track-id',
		onunmute: null as ((...args: unknown[]) => void) | null,
		// Capture the onunmute setter so tests can trigger it
		set onunmuteSetter(fn: ((...args: unknown[]) => void) | null) {
			if (onunmuteCapture) onunmuteCapture.ref = fn;
			track.onunmute = fn;
		}
	};

	// Use Object.defineProperty to intercept writes to ev.track.onunmute
	const trackWithSetter: Record<string, unknown> = {
		kind: 'video',
		id: 'track-id',
		onunmute: null
	};
	if (onunmuteCapture) {
		Object.defineProperty(trackWithSetter, 'onunmute', {
			get: () => onunmuteCapture.ref,
			set: (fn) => {
				onunmuteCapture.ref = fn;
			},
			configurable: true
		});
	}

	return {
		streams,
		track: trackWithSetter
	} as unknown as RTCTrackEvent;
};

beforeEach(() => {
	useStore.getState().setLoginInfo(user1Info.id, user1Info.email, user1Info.name);
	useStore.getState().addRooms([groupRoom]);
	useStore.getState().addMeetings([groupMeeting]);
	useStore.getState().meetingConnection(groupMeeting.id);
});

describe('VideoScreenInConnection', () => {
	describe('onTrack handler', () => {
		test('populates streamsMap and updates the store when ev.streams is non-empty', () => {
			const conn = new VideoScreenInConnection(groupMeeting.id);

			const remoteStream = buildRemoteStream('user2', STREAM_TYPE.VIDEO);
			// Trigger onTrack by invoking the peerConn.ontrack handler
			const trackEvent = buildTrackEvent([remoteStream]);
			(conn.peerConn as unknown as { ontrack: (e: RTCTrackEvent) => void }).ontrack(trackEvent);

			const subscription = useStore
				.getState()
				.activeMeeting?.subscription['user2-video'];
			expect(subscription).toBeDefined();
			expect(subscription?.stream).toBe(remoteStream);
		});

		test('attaches an onunmute listener to the incoming track (Fix 1 - Firefox fallback)', () => {
			const conn = new VideoScreenInConnection(groupMeeting.id);

			const capture = { ref: null as ((...args: unknown[]) => void) | null };
			const trackEvent = buildTrackEvent([], capture);
			(conn.peerConn as unknown as { ontrack: (e: RTCTrackEvent) => void }).ontrack(trackEvent);

			// The onunmute property must have been set on the track
			expect(capture.ref).toBeInstanceOf(Function);
		});

		test('calling the onunmute listener re-triggers updateStreams', () => {
			const conn = new VideoScreenInConnection(groupMeeting.id);

			// Pre-populate streamsMap with a valid entry so updateStreams has something to emit
			const remoteStream = buildRemoteStream('user2', STREAM_TYPE.VIDEO);
			conn.streamsMap['user2-video'] = {
				userId: 'user2',
				type: STREAM_TYPE.VIDEO,
				stream: remoteStream
			};

			const capture = { ref: null as ((...args: unknown[]) => void) | null };
			const trackEvent = buildTrackEvent([], capture);
			(conn.peerConn as unknown as { ontrack: (e: RTCTrackEvent) => void }).ontrack(trackEvent);

			// Reset the subscription so we can detect the re-trigger
			useStore.getState().setSubscribedTracks(groupMeeting.id, {});
			expect(useStore.getState().activeMeeting?.subscription['user2-video']).toBeUndefined();

			// Simulate the track unmuting (Firefox fires this when frames start flowing)
			capture.ref!();

			expect(useStore.getState().activeMeeting?.subscription['user2-video']).toBeDefined();
		});

		test('handles a stream id without a "/" separator gracefully', () => {
			const conn = new VideoScreenInConnection(groupMeeting.id);
			const badStream = { id: 'no-slash-here', active: true, getTracks: vi.fn(() => []) };
			const trackEvent = buildTrackEvent([badStream as unknown as MediaStream]);
			expect(() => {
				(conn.peerConn as unknown as { ontrack: (e: RTCTrackEvent) => void }).ontrack(
					trackEvent
				);
			}).not.toThrow();
		});
	});
});
