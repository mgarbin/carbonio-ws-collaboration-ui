/*
 * SPDX-FileCopyrightText: 2023 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { filter, forEach, keyBy } from 'lodash';

import { PeerConnConfig } from './PeerConnConfig';
import SubscriptionsManager from './SubscriptionsManager';
import useStore from '../../store/Store';
import { StreamInfo, StreamMap } from '../../types/network/models/meetingBeTypes';
import { IVideoScreenInConnection } from '../../types/network/webRTC/webRTC';
import {
	SimulcastLayer,
	STREAM_TYPE,
	StreamsSubscriptionMap,
	NetworkQualityLevel
} from '../../types/store/ActiveMeetingTypes';
import { MeetingsApi } from '../index';

// How often to measure inbound video bitrate and adjust the simulcast layer (ms).
const INBOUND_POLL_MS = 4000;
// Bitrate thresholds used to select the simulcast substream.
const INBOUND_HIGH_THRESHOLD_KBPS = 500;
const INBOUND_MEDIUM_THRESHOLD_KBPS = 150;

export default class VideoScreenInConnection implements IVideoScreenInConnection {
	peerConn: RTCPeerConnection;

	meetingId: string;

	subscriptionManager?: SubscriptionsManager;

	streamsMap: StreamMap;

	private bandwidthPollInterval: ReturnType<typeof setInterval> | null = null;

	private prevInboundBytes: number = 0;

	constructor(meetingId: string) {
		this.peerConn = new RTCPeerConnection(new PeerConnConfig().getConfig());
		this.peerConn.ontrack = this.onTrack;
		this.meetingId = meetingId;
		this.subscriptionManager = new SubscriptionsManager(meetingId);
		this.streamsMap = {};
		this.startBandwidthTracking();
	}

	// Handle remote offer creating an answer and sending it to the remote peer
	public handleRemoteOffer(sdp: string): void {
		// Detect whether the offer uses simulcast (VP8) so we can prefer the right codec.
		const isSimulcast = sdp.includes('a=simulcast') || sdp.includes('a=rid:');

		const offer = new RTCSessionDescription({ sdp, type: 'offer' });
		this.peerConn
			.setRemoteDescription(offer)
			.then(() => {
				this.peerConn.getTransceivers().forEach((transceiver) => {
					if (!RTCRtpReceiver.getCapabilities) return;
					const caps = RTCRtpReceiver.getCapabilities('video');
					if (caps) {
						let preferred: RTCRtpCodecCapability[];
						let rest: RTCRtpCodecCapability[];
						if (isSimulcast) {
							// Simulcast streams are VP8; prefer it so it is chosen during negotiation.
							preferred = caps.codecs.filter((c) => c.mimeType === 'video/VP8');
							rest = caps.codecs.filter((c) => c.mimeType !== 'video/VP8');
						} else {
							// For non-simulcast, keep the original preference (VP9 / AV1 first).
							preferred = caps.codecs.filter(
								(c) => c.mimeType === 'video/VP9' || c.mimeType === 'video/AV1'
							);
							rest = caps.codecs.filter(
								(c) => c.mimeType !== 'video/VP9' && c.mimeType !== 'video/AV1'
							);
						}
						try {
							transceiver.setCodecPreferences([...preferred, ...rest]);
						} catch {
							// setCodecPreferences is not supported in all browsers; continue without it
						}
					}
				});
				this.peerConn
					.createAnswer()
					.then((rtcSessionDesc: RTCSessionDescriptionInit) => {
						this.peerConn
							.setLocalDescription(rtcSessionDesc)
							.then(() => {
								if (rtcSessionDesc.sdp) {
									MeetingsApi.createMediaAnswer(this.meetingId, rtcSessionDesc.sdp)
										.then(() => {
											console.log('Media answer created successfully');
										})
										.catch((reason) => console.warn('Failed to create media answer', reason));
								}
							})
							.catch((reason) => console.warn('setLocalDescription failed', reason));
					})
					.catch((reason) => console.warn('createAnswer failed', reason));
			})
			.catch((reason) => console.warn('setRemoteDescription failed', reason));
	}

	public handleParticipantsSubscribed(streamsMap: StreamInfo[]): void {
		const temporaryStreams: StreamMap = {};
		forEach(streamsMap, (stream) => {
			const streamsKey = `${stream.userId}-${stream.type.toLowerCase()}`;
			temporaryStreams[streamsKey] = {
				...this.streamsMap[streamsKey],
				userId: stream.userId,
				type: stream.type.toLowerCase() as STREAM_TYPE
			};
		});

		this.streamsMap = temporaryStreams;
		this.updateStreams();
	}

	public removeStream = (streamKey: string, streamType: STREAM_TYPE[]): void => {
		forEach(streamType, (type) => {
			delete this.streamsMap[`${streamKey}-${type}`];
		});
		this.updateStreams();
	};

	private onTrack = (ev: RTCTrackEvent): void => {
		forEach(ev.streams, (stream) => {
			const userId = stream.id.split('/')[0];
			const type = stream.id.split('/')[1].toLowerCase() as STREAM_TYPE;
			if (userId && type) {
				const streamsKey = `${userId}-${type}`;
				this.streamsMap[streamsKey] = {
					...this.streamsMap[streamsKey],
					stream
				};
			}
		});
		this.updateStreams();
	};

	private updateStreams(): void {
		const completeStreams = filter(this.streamsMap, (stream) => !!stream.stream && !!stream.userId);
		const newStreams = keyBy(
			completeStreams,
			(stream) => `${stream.userId}-${stream.type}`
		) as StreamsSubscriptionMap;
		useStore.getState().setSubscribedTracks(this.meetingId, newStreams);
	}

	public requestLayer(userId: string, type: STREAM_TYPE, layer: string): void {
		if (!this.subscriptionManager) return;
		const current = this.subscriptionManager.subscriptions;
		const updated = current.map((sub) =>
			sub.userId === userId && sub.type === type ? { ...sub, layer } : sub
		);
		this.subscriptionManager.updateSubscription(updated);
	}

	// Map network quality level to a Janus VideoRoom simulcast substream index:
	// '2' = high (scaleResolutionDownBy 1), '1' = medium (×2), '0' = low (×4).
	public setInboundQuality(level: NetworkQualityLevel): void {
		if (!this.subscriptionManager) return;
		const layerByQuality: Partial<Record<NetworkQualityLevel, string>> = {
			[NetworkQualityLevel.GOOD]: SimulcastLayer.HIGH,
			[NetworkQualityLevel.FAIR]: SimulcastLayer.MEDIUM,
			[NetworkQualityLevel.POOR]: SimulcastLayer.LOW
		};
		const layer = layerByQuality[level];
		if (!layer) return;
		const updated = this.subscriptionManager.subscriptions.map((sub) => ({ ...sub, layer }));
		this.subscriptionManager.updateSubscription(updated);
	}

	// Poll inbound video stats and switch the simulcast substream based on measured bitrate.
	private startBandwidthTracking(): void {
		this.bandwidthPollInterval = setInterval(() => {
			this.peerConn
				.getStats()
				.then((statsReport) => {
					let totalBytes = 0;
					statsReport.forEach((report) => {
						if (
							report.type === 'inbound-rtp' &&
							(report as RTCInboundRtpStreamStats).kind === 'video'
						) {
							totalBytes += (report as RTCInboundRtpStreamStats).bytesReceived ?? 0;
						}
					});

					const prevBytes = this.prevInboundBytes;
					this.prevInboundBytes = totalBytes;

					// Skip the first sample — we need two readings to compute a delta.
					if (prevBytes === 0) return;

					const bitrateKbps = Math.round(
						((totalBytes - prevBytes) * 8) / (INBOUND_POLL_MS / 1000) / 1000
					);

					let layer: string;
					if (bitrateKbps >= INBOUND_HIGH_THRESHOLD_KBPS) {
						layer = SimulcastLayer.HIGH;
					} else if (bitrateKbps >= INBOUND_MEDIUM_THRESHOLD_KBPS) {
						layer = SimulcastLayer.MEDIUM;
					} else {
						layer = SimulcastLayer.LOW;
					}

					if (!this.subscriptionManager) return;
					const updated = this.subscriptionManager.subscriptions.map((sub) => ({
						...sub,
						layer
					}));
					this.subscriptionManager.updateSubscription(updated);
				})
				.catch(() => undefined);
		}, INBOUND_POLL_MS);
	}

	public closePeerConnection(): void {
		if (this.bandwidthPollInterval !== null) {
			clearInterval(this.bandwidthPollInterval);
			this.bandwidthPollInterval = null;
		}
		delete this.subscriptionManager;
		this.peerConn?.close?.();
	}
}
