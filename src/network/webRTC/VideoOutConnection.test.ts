/*
 * SPDX-FileCopyrightText: 2024 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import VideoOutConnection from './VideoOutConnection';
import useStore from '../../store/Store';
import { STREAM_TYPE } from '../../types/store/ActiveMeetingTypes';
import { mockFetchAPI } from '../../utils/__mocks__/FetchUtils';

const meetingId = 'meeting-test';

vi.mock('../../utils/FetchUtils');

// Build a fully-featured RTCRtpSender stub that records calls to replaceTrack.
const buildSenderStub = (initialTrack: MediaStreamTrack | null = null) => {
	const stub = {
		track: initialTrack,
		replaceTrack: vi.fn((newTrack: MediaStreamTrack | null) => {
			stub.track = newTrack;
			return Promise.resolve();
		})
	};
	return stub;
};

// Build a MediaStream stub whose getVideoTracks() returns the given track.
const buildStreamStub = (track: MediaStreamTrack) => ({
	getVideoTracks: vi.fn(() => [track]),
	getTracks: vi.fn(() => [track]),
	addTrack: vi.fn(),
	active: true
});

// Build a MediaStreamTrack stub.
const buildTrackStub = (id = 'track-1') => ({
	id,
	kind: 'video',
	enabled: true,
	readyState: 'live' as MediaStreamTrack['readyState'],
	stop: vi.fn(),
	onunmute: null as EventListener | null
});

describe('VideoOutConnection', () => {
	beforeEach(() => {
		useStore.getState().meetingConnection(meetingId);
	});

	describe('stopVideo()', () => {
		test('calls replaceTrack(null) on the sender instead of closing the peer connection', () => {
			const track = buildTrackStub('original-track');
			const sender = buildSenderStub(track as unknown as MediaStreamTrack);
			const peerConnStub = {
				addTrack: vi.fn(() => sender),
				close: vi.fn(),
				onnegotiationneeded: null as unknown,
				oniceconnectionstatechange: null as unknown
			};
			vi.spyOn(window, 'RTCPeerConnection').mockImplementation(
				() => peerConnStub as unknown as RTCPeerConnection
			);

			const conn = new VideoOutConnection(meetingId, false);
			// Manually wire up an rtpSender as if startVideo was previously called
			conn.peerConn = peerConnStub as unknown as RTCPeerConnection;
			conn.rtpSender = sender as unknown as RTCRtpSender;

			conn.stopVideo();

			expect(sender.replaceTrack).toHaveBeenCalledTimes(1);
			expect(sender.replaceTrack).toHaveBeenCalledWith(null);
			// The peer connection must remain alive
			expect(conn.peerConn).not.toBeNull();
			expect(conn.rtpSender).not.toBeNull();
			expect(peerConnStub.close).not.toHaveBeenCalled();
		});

		test('removes the local video stream from the store', () => {
			const conn = new VideoOutConnection(meetingId, false);
			conn.peerConn = {
				addTrack: vi.fn(),
				close: vi.fn()
			} as unknown as RTCPeerConnection;
			const track = buildTrackStub();
			const stream = buildStreamStub(track as unknown as MediaStreamTrack);
			useStore.getState().setLocalStreams(STREAM_TYPE.VIDEO, stream as unknown as MediaStream);
			expect(useStore.getState().activeMeeting?.localStreams.video).toBeDefined();

			conn.stopVideo();

			expect(useStore.getState().activeMeeting?.localStreams.video).toBeUndefined();
		});

		test('notifies the server that video is off via updateMediaOffer', () => {
			const conn = new VideoOutConnection(meetingId, false);
			conn.peerConn = {
				addTrack: vi.fn(),
				close: vi.fn()
			} as unknown as RTCPeerConnection;

			conn.stopVideo();

			expect(mockFetchAPI).toHaveBeenCalledWith(
				`meetings/${meetingId}/media`,
				'PUT',
				expect.objectContaining({ enabled: false, type: STREAM_TYPE.VIDEO })
			);
		});
	});

	describe('updateLocalStreamTrack()', () => {
		test('does NOT call stop() on the old track before replaceTrack (Fix 2)', async () => {
			const oldTrack = buildTrackStub('old-track');
			const newTrack = buildTrackStub('new-track');
			const sender = buildSenderStub(oldTrack as unknown as MediaStreamTrack);
			const peerConnStub = {
				addTrack: vi.fn(),
				close: vi.fn()
			};

			const conn = new VideoOutConnection(meetingId, false);
			conn.peerConn = peerConnStub as unknown as RTCPeerConnection;
			conn.rtpSender = sender as unknown as RTCRtpSender;

			const newStream = buildStreamStub(newTrack as unknown as MediaStreamTrack);
			await conn.updateLocalStreamTrack(newStream as unknown as MediaStream);

			expect(oldTrack.stop).not.toHaveBeenCalled();
			expect(sender.replaceTrack).toHaveBeenCalledWith(newTrack);
		});

		test('calls replaceTrack even when sender track is null (after stopVideo Fix 3)', async () => {
			const newTrack = buildTrackStub('new-track');
			// Simulate the state after stopVideo(): sender.track === null
			const sender = buildSenderStub(null);
			const peerConnStub = { addTrack: vi.fn(), close: vi.fn() };

			const conn = new VideoOutConnection(meetingId, false);
			conn.peerConn = peerConnStub as unknown as RTCPeerConnection;
			conn.rtpSender = sender as unknown as RTCRtpSender;

			const newStream = buildStreamStub(newTrack as unknown as MediaStreamTrack);
			await conn.updateLocalStreamTrack(newStream as unknown as MediaStream);

			expect(sender.replaceTrack).toHaveBeenCalledWith(newTrack);
		});

		test('calls addTrack (not replaceTrack) when rtpSender is null', async () => {
			const track = buildTrackStub();
			const sender = buildSenderStub(track as unknown as MediaStreamTrack);
			const peerConnStub = { addTrack: vi.fn(() => sender), close: vi.fn() };

			const conn = new VideoOutConnection(meetingId, false);
			conn.peerConn = peerConnStub as unknown as RTCPeerConnection;
			conn.rtpSender = null;

			const stream = buildStreamStub(track as unknown as MediaStreamTrack);
			await conn.updateLocalStreamTrack(stream as unknown as MediaStream);

			expect(peerConnStub.addTrack).toHaveBeenCalled();
			expect(sender.replaceTrack).not.toHaveBeenCalled();
		});
	});

	describe('closePeerConnection()', () => {
		test('nulls out peerConn and rtpSender', () => {
			const track = buildTrackStub();
			const sender = buildSenderStub(track as unknown as MediaStreamTrack);
			const peerConnStub = { addTrack: vi.fn(), close: vi.fn() };

			const conn = new VideoOutConnection(meetingId, false);
			conn.peerConn = peerConnStub as unknown as RTCPeerConnection;
			conn.rtpSender = sender as unknown as RTCRtpSender;

			conn.closePeerConnection();

			expect(conn.peerConn).toBeNull();
			expect(conn.rtpSender).toBeNull();
			expect(peerConnStub.close).toHaveBeenCalled();
		});
	});
});
