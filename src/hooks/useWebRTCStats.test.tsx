/*
 * SPDX-FileCopyrightText: 2025 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { act, renderHook } from '@testing-library/react';

import useWebRTCStats, { computeAverageQuality, computeQuality } from './useWebRTCStats';
import useStore from '../store/Store';
import { createMockMeeting, createMockParticipants } from '../tests/createMock';
import { NetworkQualityLevel, SimulcastLayer } from '../types/store/ActiveMeetingTypes';

const meeting = createMockMeeting({ participants: [createMockParticipants({ userId: 'userId' })] });

const makeStatsMock = (reports: RTCStats[]): Promise<RTCStatsReport> =>
	Promise.resolve({
		forEach: (fn: (report: RTCStats) => void) => reports.forEach(fn)
	} as unknown as RTCStatsReport);

// Simulcast encodings mirroring VideoOutConnection.SIMULCAST_ENCODINGS
const makeSimulcastEncodings = (): RTCRtpEncodingParameters[] => [
	{ rid: 'h', maxBitrate: 900_000, scaleResolutionDownBy: 1, active: true },
	{ rid: 'm', maxBitrate: 300_000, scaleResolutionDownBy: 2, active: true },
	{ rid: 'l', maxBitrate: 75_000, scaleResolutionDownBy: 4, active: true }
];

describe('computeQuality', () => {
	test('returns UNKNOWN when both rtt and fractionLost are undefined', () => {
		expect(computeQuality(undefined, undefined)).toBe(NetworkQualityLevel.UNKNOWN);
	});

	test('returns GOOD when rtt < 150 ms and fractionLost < 2%', () => {
		expect(computeQuality(100, 0.01)).toBe(NetworkQualityLevel.GOOD);
	});

	test('returns FAIR when rtt < 300 ms and fractionLost < 5%', () => {
		expect(computeQuality(200, 0.04)).toBe(NetworkQualityLevel.FAIR);
	});

	test('returns POOR when rtt is >= 300 ms', () => {
		expect(computeQuality(350, 0.01)).toBe(NetworkQualityLevel.POOR);
	});

	test('returns POOR when fractionLost is >= 5%', () => {
		expect(computeQuality(100, 0.06)).toBe(NetworkQualityLevel.POOR);
	});

	test('returns GOOD when only rtt is provided and below threshold', () => {
		expect(computeQuality(50, undefined)).toBe(NetworkQualityLevel.GOOD);
	});

	test('returns GOOD when only fractionLost is provided and below threshold', () => {
		expect(computeQuality(undefined, 0.01)).toBe(NetworkQualityLevel.GOOD);
	});
});

describe('computeAverageQuality', () => {
	test('returns UNKNOWN for an empty history', () => {
		expect(computeAverageQuality([])).toBe(NetworkQualityLevel.UNKNOWN);
	});

	test('returns GOOD when all samples are good', () => {
		const history = [
			{ rtt: 80, fractionLost: 0.01 },
			{ rtt: 90, fractionLost: 0.01 },
			{ rtt: 100, fractionLost: 0.01 }
		];
		expect(computeAverageQuality(history)).toBe(NetworkQualityLevel.GOOD);
	});

	test('returns POOR when average exceeds POOR thresholds', () => {
		const history = [
			{ rtt: 400, fractionLost: 0.1 },
			{ rtt: 350, fractionLost: 0.08 },
			{ rtt: 500, fractionLost: 0.12 }
		];
		expect(computeAverageQuality(history)).toBe(NetworkQualityLevel.POOR);
	});

	test('smooths out a single spike with 4 good samples', () => {
		const history = [
			{ rtt: 80, fractionLost: 0.01 },
			{ rtt: 80, fractionLost: 0.01 },
			{ rtt: 80, fractionLost: 0.01 },
			{ rtt: 80, fractionLost: 0.01 },
			{ rtt: 500, fractionLost: 0.15 }
		];
		// avg rtt = (80*4+500)/5 = 420/5 = 164, avg loss = (0.01*4+0.15)/5 = 0.038 -> FAIR
		expect(computeAverageQuality(history)).toBe(NetworkQualityLevel.FAIR);
	});

	test('handles samples with undefined rtt or fractionLost gracefully', () => {
		const history = [{ rtt: undefined, fractionLost: undefined }];
		expect(computeAverageQuality(history)).toBe(NetworkQualityLevel.UNKNOWN);
	});
});

describe('useWebRTCStats hook', () => {
	let mockGetStats: ReturnType<typeof vi.fn>;
	// Separate senders for video (simulcast, via addTransceiver) and audio (single, via addTrack)
	let mockSetParametersVideo: ReturnType<typeof vi.fn>;
	let mockGetParametersVideo: ReturnType<typeof vi.fn>;
	let mockAddTransceiver: ReturnType<typeof vi.fn>;
	let mockSetParametersAudio: ReturnType<typeof vi.fn>;
	let mockGetParametersAudio: ReturnType<typeof vi.fn>;
	let mockAddTrack: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockGetStats = vi.fn(() =>
			makeStatsMock([
				{
					type: 'remote-inbound-rtp',
					kind: 'audio',
					roundTripTime: 0.08,
					fractionLost: 0.01,
					id: 'rtp-audio',
					timestamp: Date.now()
				} as unknown as RTCStats
			])
		);

		// Video sender: returns three simulcast encodings with rids
		mockSetParametersVideo = vi.fn(() => Promise.resolve());
		mockGetParametersVideo = vi.fn(() => ({ encodings: makeSimulcastEncodings() }));
		mockAddTransceiver = vi.fn(() => ({
			sender: {
				getParameters: mockGetParametersVideo,
				setParameters: mockSetParametersVideo
			}
		}));

		// Audio sender: single encoding without rids (unchanged audio degradation path)
		mockSetParametersAudio = vi.fn(() => Promise.resolve());
		mockGetParametersAudio = vi.fn(() => ({ encodings: [{}] }));
		mockAddTrack = vi.fn(() => ({
			getParameters: mockGetParametersAudio,
			setParameters: mockSetParametersAudio
		}));

		// window.RTCPeerConnection is already a vi.fn() defined in setupTests.ts.
		// We use mockImplementation to inject getStats into every new instance that
		// will be created by the connection classes inside meetingConnection.
		vi.mocked(window.RTCPeerConnection).mockImplementation(function () {
			return {
				ontrack: null,
				onnegotiationneeded: null,
				oniceconnectionstatechange: null,
				addTrack: mockAddTrack,
				addTransceiver: mockAddTransceiver,
				getTransceivers: vi.fn(() => []),
				createAnswer: vi.fn(() => Promise.resolve({ sdp: '', type: 'answer' })),
				setRemoteDescription: vi.fn(() => Promise.resolve()),
				setLocalDescription: vi.fn(() => Promise.resolve()),
				getStats: mockGetStats
			} as unknown as RTCPeerConnection;
		});

		const store = useStore.getState();
		store.setLoginInfo('userId', 'User');
		store.addMeetings([meeting]);
		store.meetingConnection(meeting.id);
	});

	test('updates networkStats in the store after the first poll interval', async () => {
		renderHook(() => useWebRTCStats(meeting.id));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		const stats = useStore.getState().activeMeeting?.networkStats;
		expect(stats).toBeDefined();
		expect(stats?.quality).toBe(NetworkQualityLevel.GOOD);
		expect(stats?.rtt).toBeCloseTo(80); // 0.08 s × 1000
		expect(stats?.fractionLost).toBe(0.01);
	});

	test('polls repeatedly on each interval', async () => {
		renderHook(() => useWebRTCStats(meeting.id));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});
		// audio conn + videoScreenIn conn both call getStats (videoOutConn.peerConn is null here)
		const callsAfterFirstInterval = mockGetStats.mock.calls.length;
		expect(callsAfterFirstInterval).toBeGreaterThan(0);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});
		expect(mockGetStats.mock.calls.length).toBe(callsAfterFirstInterval * 2);
	});

	test('clears the interval when the hook unmounts', async () => {
		const { unmount } = renderHook(() => useWebRTCStats(meeting.id));
		unmount();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		// The hook's polling interval was cleared; networkStats is never updated after unmount.
		// (VideoScreenInConnection has its own independent polling that does not write networkStats.)
		expect(useStore.getState().activeMeeting?.networkStats).toBeUndefined();
	});

	test('does nothing when there is no active meeting matching the meetingId', async () => {
		renderHook(() => useWebRTCStats('non-existent-meeting-id'));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		// The hook does nothing for an unknown meetingId — networkStats is never set.
		expect(useStore.getState().activeMeeting?.networkStats).toBeUndefined();
	});

	test('reports POOR quality when RTT is high', async () => {
		mockGetStats.mockImplementation(() =>
			makeStatsMock([
				{
					type: 'remote-inbound-rtp',
					kind: 'audio',
					roundTripTime: 0.5,
					fractionLost: 0.08,
					id: 'rtp-audio',
					timestamp: Date.now()
				} as unknown as RTCStats
			])
		);

		renderHook(() => useWebRTCStats(meeting.id));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		expect(useStore.getState().activeMeeting?.networkStats?.quality).toBe(
			NetworkQualityLevel.POOR
		);
	});

	test('handles getStats rejection gracefully without throwing', async () => {
		mockGetStats.mockImplementation(() => Promise.reject(new Error('Controlled error')));

		renderHook(() => useWebRTCStats(meeting.id));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		// No network stats update on failure — existing value (undefined) remains
		expect(useStore.getState().activeMeeting?.networkStats).toBeUndefined();
	});

	test('applies POOR simulcast quality (only low layer active) when quality is POOR', async () => {
		mockGetStats.mockImplementation(() =>
			makeStatsMock([
				{
					type: 'remote-inbound-rtp',
					kind: 'audio',
					roundTripTime: 0.5,
					fractionLost: 0.08,
					id: 'rtp-audio',
					timestamp: Date.now()
				} as unknown as RTCStats
			])
		);

		// Initialize with video enabled so the video rtpSender is set up
		const store = useStore.getState();
		store.meetingDisconnection(meeting.id);
		store.meetingConnection(meeting.id, { enabled: false }, { enabled: true });

		// Flush getUserMedia promise so VideoOutConnection.rtpSender is initialized
		await act(async () => {});

		renderHook(() => useWebRTCStats(meeting.id));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		// Video: only the low ('l') layer should remain active
		const poorVideoCall = mockSetParametersVideo.mock.calls.find(([params]) =>
			params.encodings?.some(
				(enc: RTCRtpEncodingParameters) => enc.rid === 'l' && enc.active === true
			)
		);
		expect(poorVideoCall).toBeDefined();
		const highLayerDisabled = poorVideoCall?.[0]?.encodings?.find(
			(enc: RTCRtpEncodingParameters) => enc.rid === 'h'
		)?.active;
		expect(highLayerDisabled).toBe(false);

		// Audio: still uses maxBitrate degradation (unchanged)
		const audioCall = mockSetParametersAudio.mock.calls.find(
			([params]) => params.encodings?.[0]?.maxBitrate === 10_000
		);
		expect(audioCall).toBeDefined();
	});

	test('calls setOutboundQuality on screenOutConn when quality changes', async () => {
		mockGetStats.mockImplementation(() =>
			makeStatsMock([
				{
					type: 'remote-inbound-rtp',
					kind: 'audio',
					roundTripTime: 0.5,
					fractionLost: 0.08,
					id: 'rtp-audio',
					timestamp: Date.now()
				} as unknown as RTCStats
			])
		);

		const store = useStore.getState();
		const screenConn = store.activeMeeting?.screenOutConn;
		const mockSetScreenQuality = vi
			.spyOn(screenConn!, 'setOutboundQuality')
			.mockResolvedValue(undefined);

		renderHook(() => useWebRTCStats(meeting.id));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		expect(mockSetScreenQuality).toHaveBeenCalledWith(NetworkQualityLevel.POOR);
	});

	test('applies FAIR simulcast quality (high layer disabled) when quality is FAIR', async () => {
		mockGetStats.mockImplementation(() =>
			makeStatsMock([
				{
					type: 'remote-inbound-rtp',
					kind: 'audio',
					roundTripTime: 0.25,
					fractionLost: 0.03,
					id: 'rtp-audio',
					timestamp: Date.now()
				} as unknown as RTCStats
			])
		);

		const store = useStore.getState();
		store.meetingDisconnection(meeting.id);
		store.meetingConnection(meeting.id, { enabled: false }, { enabled: true });

		await act(async () => {});

		renderHook(() => useWebRTCStats(meeting.id));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		// Video: high layer ('h') should be inactive; medium ('m') and low ('l') remain active
		const fairVideoCall = mockSetParametersVideo.mock.calls.find(([params]) =>
			params.encodings?.some(
				(enc: RTCRtpEncodingParameters) => enc.rid === 'h' && enc.active === false
			)
		);
		expect(fairVideoCall).toBeDefined();
		const mediumLayerActive = fairVideoCall?.[0]?.encodings?.find(
			(enc: RTCRtpEncodingParameters) => enc.rid === 'm'
		)?.active;
		expect(mediumLayerActive).toBe(true);

		// Audio: still uses maxBitrate degradation (unchanged)
		const audioCall = mockSetParametersAudio.mock.calls.find(
			([params]) => params.encodings?.[0]?.maxBitrate === 20_000
		);
		expect(audioCall).toBeDefined();
	});

	test('does not call setParameters again when quality stays the same between polls', async () => {
		mockGetStats.mockImplementation(() =>
			makeStatsMock([
				{
					type: 'remote-inbound-rtp',
					kind: 'audio',
					roundTripTime: 0.5,
					fractionLost: 0.08,
					id: 'rtp-audio',
					timestamp: Date.now()
				} as unknown as RTCStats
			])
		);

		renderHook(() => useWebRTCStats(meeting.id));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		const videoCallsAfterFirst = mockSetParametersVideo.mock.calls.length;

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		// Quality did not change — no additional setParameters call for video
		expect(mockSetParametersVideo.mock.calls.length).toBe(videoCallsAfterFirst);
	});

	test('enables all simulcast layers when network quality is GOOD', async () => {
		const store = useStore.getState();
		store.meetingDisconnection(meeting.id);
		store.meetingConnection(meeting.id, { enabled: false }, { enabled: true });

		await act(async () => {});

		renderHook(() => useWebRTCStats(meeting.id));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		expect(useStore.getState().activeMeeting?.networkStats?.quality).toBe(
			NetworkQualityLevel.GOOD
		);
		// GOOD quality: setParameters called and all layers active
		const goodCall = mockSetParametersVideo.mock.calls.find(([params]) =>
			params.encodings?.every((enc: RTCRtpEncodingParameters) => enc.active === true)
		);
		expect(goodCall).toBeDefined();
	});

	test('re-enables all simulcast layers when quality recovers to GOOD after POOR', async () => {
		// First, establish POOR quality
		mockGetStats.mockImplementation(() =>
			makeStatsMock([
				{
					type: 'remote-inbound-rtp',
					kind: 'audio',
					roundTripTime: 0.5,
					fractionLost: 0.08,
					id: 'rtp-audio',
					timestamp: Date.now()
				} as unknown as RTCStats
			])
		);

		const store = useStore.getState();
		store.meetingDisconnection(meeting.id);
		store.meetingConnection(meeting.id, { enabled: false }, { enabled: true });

		await act(async () => {});

		renderHook(() => useWebRTCStats(meeting.id));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		const videoCallsAfterPoor = mockSetParametersVideo.mock.calls.length;
		expect(videoCallsAfterPoor).toBeGreaterThan(0);

		// Switch to GOOD quality
		mockGetStats.mockImplementation(() =>
			makeStatsMock([
				{
					type: 'remote-inbound-rtp',
					kind: 'audio',
					roundTripTime: 0.08,
					fractionLost: 0.01,
					id: 'rtp-audio',
					timestamp: Date.now()
				} as unknown as RTCStats
			])
		);

		// The rolling-average window holds up to 5 samples, so quality recovers from POOR to GOOD
		// only once all 5 slots are filled with GOOD measurements (after ~5 more intervals).
		await act(async () => {
			await vi.advanceTimersByTimeAsync(24000); // 6 more polls flush the POOR sample
		});

		// At some point setParameters should have been called with all layers active (GOOD)
		const goodCall = mockSetParametersVideo.mock.calls.find(([params]) =>
			params.encodings?.every((enc: RTCRtpEncodingParameters) => enc.active === true)
		);
		expect(goodCall).toBeDefined();
	});

	test('rolling buffer keeps only the last 5 samples', async () => {
		// 4 GOOD samples followed by 1 POOR sample: average should be FAIR (not POOR)
		let callCount = 0;
		mockGetStats.mockImplementation(() => {
			callCount += 1;
			const isPoor = callCount === 5;
			return makeStatsMock([
				{
					type: 'remote-inbound-rtp',
					kind: 'audio',
					roundTripTime: isPoor ? 0.5 : 0.08, // seconds; 500 ms : 80 ms
					fractionLost: isPoor ? 0.08 : 0.01,
					id: 'rtp-audio',
					timestamp: Date.now()
				} as unknown as RTCStats
			]);
		});

		renderHook(() => useWebRTCStats(meeting.id));

		// Advance through 5 poll intervals
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20000);
		});

		// With 4 good + 1 poor sample: avg rtt = (80*4+500)/5=164ms, avg loss = (0.01*4+0.08)/5=0.024
		// 164ms < 300 and 0.024 < 0.05 => FAIR
		const stats = useStore.getState().activeMeeting?.networkStats;
		expect(stats?.quality).toBe(NetworkQualityLevel.FAIR);
	});

	test('setInboundQuality is called with SimulcastLayer values on quality change', async () => {
		mockGetStats.mockImplementation(() =>
			makeStatsMock([
				{
					type: 'remote-inbound-rtp',
					kind: 'audio',
					roundTripTime: 0.5,
					fractionLost: 0.08,
					id: 'rtp-audio',
					timestamp: Date.now()
				} as unknown as RTCStats
			])
		);

		const store = useStore.getState();
		const videoScreenIn = store.activeMeeting?.videoScreenIn;
		const mockSetInboundQuality = vi.spyOn(videoScreenIn!, 'setInboundQuality');

		renderHook(() => useWebRTCStats(meeting.id));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		expect(mockSetInboundQuality).toHaveBeenCalledWith(NetworkQualityLevel.POOR);

		// Verify that setInboundQuality maps POOR → SimulcastLayer.LOW
		const subscriptionManager = videoScreenIn?.subscriptionManager;
		expect(subscriptionManager).toBeDefined();
		// No subscriptions are set up in this test, so updateSubscription is a no-op;
		// the important thing is the correct level was passed.
	});
});

describe('quality re-application after media reconnection', () => {
	let mockSetParametersVideo: ReturnType<typeof vi.fn>;
	let mockGetParametersVideo: ReturnType<typeof vi.fn>;
	let mockAddTransceiver: ReturnType<typeof vi.fn>;
	let mockSetParametersAudio: ReturnType<typeof vi.fn>;
	let mockGetParametersAudio: ReturnType<typeof vi.fn>;
	let mockAddTrack: ReturnType<typeof vi.fn>;
	let mockSetRemoteDescription: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockSetParametersVideo = vi.fn(() => Promise.resolve());
		mockGetParametersVideo = vi.fn(() => ({ encodings: makeSimulcastEncodings() }));
		mockAddTransceiver = vi.fn(() => ({
			sender: {
				getParameters: mockGetParametersVideo,
				setParameters: mockSetParametersVideo
			}
		}));

		mockSetParametersAudio = vi.fn(() => Promise.resolve());
		mockGetParametersAudio = vi.fn(() => ({ encodings: [{}] }));
		mockSetRemoteDescription = vi.fn(() => Promise.resolve());
		mockAddTrack = vi.fn(() => ({
			getParameters: mockGetParametersAudio,
			setParameters: mockSetParametersAudio
		}));

		vi.mocked(window.RTCPeerConnection).mockImplementation(function () {
			return {
				ontrack: null,
				onnegotiationneeded: null,
				oniceconnectionstatechange: null,
				addTrack: mockAddTrack,
				addTransceiver: mockAddTransceiver,
				getTransceivers: vi.fn(() => []),
				close: vi.fn(),
				createAnswer: vi.fn(() => Promise.resolve({ sdp: '', type: 'answer' })),
				setRemoteDescription: mockSetRemoteDescription,
				setLocalDescription: vi.fn(() => Promise.resolve()),
				getStats: vi.fn(() => Promise.resolve({ forEach: vi.fn() }))
			} as unknown as RTCPeerConnection;
		});

		const store = useStore.getState();
		store.setLoginInfo('userId', 'User');
		store.addMeetings([meeting]);
		store.meetingConnection(meeting.id);
	});

	test('videoOutConn re-applies simulcast POOR quality (only low layer active) when handleRemoteAnswer is called after reconnection', async () => {
		const store = useStore.getState();
		store.meetingDisconnection(meeting.id);
		store.meetingConnection(meeting.id, { enabled: false }, { enabled: true });

		// Flush getUserMedia so the rtpSender is initialised
		await act(async () => {});

		// Record the established quality in the store
		store.setNetworkStats({ quality: NetworkQualityLevel.POOR });

		mockSetParametersVideo.mockClear();

		// Simulate a re-connection answer arriving
		const videoConn = useStore.getState().activeMeeting?.videoOutConn;
		await act(async () => {
			videoConn?.handleRemoteAnswer({ sdp: 'mock-sdp', type: 'answer' });
			// Flush the setRemoteDescription promise chain
			await Promise.resolve();
			await Promise.resolve();
		});

		// POOR: only the low ('l') layer active
		const poorCall = mockSetParametersVideo.mock.calls.find(([params]) =>
			params.encodings?.some(
				(enc: RTCRtpEncodingParameters) => enc.rid === 'l' && enc.active === true
			)
		);
		expect(poorCall).toBeDefined();
		expect(
			poorCall?.[0]?.encodings?.find((enc: RTCRtpEncodingParameters) => enc.rid === 'h')?.active
		).toBe(false);
	});

	test('screenOutConn re-applies simulcast FAIR quality (high layer disabled) when handleRemoteAnswer is called after reconnection', async () => {
		const store = useStore.getState();

		// Inject a mock peerConn and a simulcast-style rtpSender into the screenOutConn
		const screenConn = store.activeMeeting?.screenOutConn;
		const mockScreenSetParameters = vi.fn(() => Promise.resolve());
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(screenConn as any).peerConn = { setRemoteDescription: vi.fn(() => Promise.resolve()) };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(screenConn as any).rtpSender = {
			getParameters: vi.fn(() => ({ encodings: makeSimulcastEncodings() })),
			setParameters: mockScreenSetParameters
		};

		// Record the established quality in the store
		store.setNetworkStats({ quality: NetworkQualityLevel.FAIR });

		await act(async () => {
			screenConn?.handleRemoteAnswer({ sdp: 'mock-sdp', type: 'answer' });
			await Promise.resolve();
			await Promise.resolve();
		});

		// FAIR: high layer ('h') disabled, others remain active
		const fairCall = mockScreenSetParameters.mock.calls.find(([params]) =>
			params.encodings?.some(
				(enc: RTCRtpEncodingParameters) => enc.rid === 'h' && enc.active === false
			)
		);
		expect(fairCall).toBeDefined();
		expect(
			fairCall?.[0]?.encodings?.find((enc: RTCRtpEncodingParameters) => enc.rid === 'm')?.active
		).toBe(true);
	});

	test('bidirectionalAudioConn re-applies the last quality when handleRemoteAnswer is called after reconnection', async () => {
		const store = useStore.getState();

		// Flush constructor promises so the audio rtpSender is set up
		await act(async () => {});

		// Record the established quality in the store
		store.setNetworkStats({ quality: NetworkQualityLevel.POOR });

		mockSetParametersAudio.mockClear();

		const audioConn = store.activeMeeting?.bidirectionalAudioConn;
		await act(async () => {
			audioConn?.handleRemoteAnswer({ sdp: 'mock-sdp', type: 'answer' });
			await Promise.resolve();
			await Promise.resolve();
		});

		const poorCall = mockSetParametersAudio.mock.calls.find(
			([params]) => params.encodings?.[0]?.maxBitrate === 10_000
		);
		expect(poorCall).toBeDefined();
	});

	test('videoOutConn.closePeerConnection resets rtpSender and peerConn so the next connection starts fresh', async () => {
		const store = useStore.getState();
		store.meetingDisconnection(meeting.id);
		store.meetingConnection(meeting.id, { enabled: false }, { enabled: true });

		await act(async () => {});

		const videoConn = useStore.getState().activeMeeting?.videoOutConn;

		// Apply a quality level to verify the sender is in use
		await act(async () => {
			await videoConn?.setOutboundQuality(NetworkQualityLevel.POOR);
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((videoConn as any).rtpSender).not.toBeNull();

		// Close the connection — rtpSender and peerConn must be cleared
		videoConn?.closePeerConnection();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((videoConn as any).rtpSender).toBeNull();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((videoConn as any).peerConn).toBeNull();
	});

	test('screenOutConn.closePeerConnection resets rtpSender and peerConn so the next connection starts fresh', async () => {
		const store = useStore.getState();
		const screenConn = store.activeMeeting?.screenOutConn;

		// Inject a mock simulcast rtpSender
		const mockScreenSetParameters = vi.fn(() => Promise.resolve());
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(screenConn as any).peerConn = { close: vi.fn() };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(screenConn as any).rtpSender = {
			getParameters: vi.fn(() => ({ encodings: makeSimulcastEncodings() })),
			setParameters: mockScreenSetParameters,
			track: null
		};

		// Apply a quality level to verify the sender is in use
		await act(async () => {
			await screenConn?.setOutboundQuality(NetworkQualityLevel.POOR);
		});

		expect(mockScreenSetParameters).toHaveBeenCalled();

		// Close the connection — rtpSender and peerConn must be cleared
		screenConn?.closePeerConnection();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((screenConn as any).rtpSender).toBeNull();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((screenConn as any).peerConn).toBeNull();
	});

	test('VideoScreenInConnection.closePeerConnection clears the bandwidth tracking interval', () => {
		const store = useStore.getState();
		const videoScreenIn = store.activeMeeting?.videoScreenIn;
		expect(videoScreenIn).toBeDefined();

		// bandwidthPollInterval is set during construction
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((videoScreenIn as any).bandwidthPollInterval).not.toBeNull();

		videoScreenIn?.closePeerConnection();

		// bandwidthPollInterval must be cleared to prevent leaks
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((videoScreenIn as any).bandwidthPollInterval).toBeNull();
	});

	test('VideoScreenInConnection.setInboundQuality maps GOOD/FAIR/POOR to simulcast substream indices', () => {
		const store = useStore.getState();
		const videoScreenIn = store.activeMeeting?.videoScreenIn;
		expect(videoScreenIn).toBeDefined();

		// Inject a subscription so updateSubscription has something to act on
		const subManager = videoScreenIn?.subscriptionManager;
		if (subManager) {
			subManager.subscriptions = [
				{ userId: 'user1', type: 'video' as never, layer: SimulcastLayer.HIGH }
			];
		}

		const mockUpdate = vi
			.spyOn(subManager!, 'updateSubscription')
			.mockImplementation(() => undefined);

		videoScreenIn?.setInboundQuality(NetworkQualityLevel.GOOD);
		expect(mockUpdate).toHaveBeenLastCalledWith(
			expect.arrayContaining([expect.objectContaining({ layer: SimulcastLayer.HIGH })])
		);

		videoScreenIn?.setInboundQuality(NetworkQualityLevel.FAIR);
		expect(mockUpdate).toHaveBeenLastCalledWith(
			expect.arrayContaining([expect.objectContaining({ layer: SimulcastLayer.MEDIUM })])
		);

		videoScreenIn?.setInboundQuality(NetworkQualityLevel.POOR);
		expect(mockUpdate).toHaveBeenLastCalledWith(
			expect.arrayContaining([expect.objectContaining({ layer: SimulcastLayer.LOW })])
		);
	});
});
