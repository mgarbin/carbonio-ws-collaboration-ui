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
	STREAM_TYPE,
	StreamsSubscriptionMap,
	NetworkQualityLevel
} from '../../types/store/ActiveMeetingTypes';
import { MeetingsApi } from '../index';

export default class VideoScreenInConnection implements IVideoScreenInConnection {
	peerConn: RTCPeerConnection;

	meetingId: string;

	subscriptionManager?: SubscriptionsManager;

	streamsMap: StreamMap;

	constructor(meetingId: string) {
		this.peerConn = new RTCPeerConnection(new PeerConnConfig().getConfig());
		this.peerConn.ontrack = this.onTrack;
		this.meetingId = meetingId;
		this.subscriptionManager = new SubscriptionsManager(meetingId);
		this.streamsMap = {};
	}

	// Handle remote offer creating an answer and sending it to the remote peer
	public handleRemoteOffer(sdp: string): void {
		const offer = new RTCSessionDescription({ sdp, type: 'offer' });
		this.peerConn
			.setRemoteDescription(offer)
			.then(() => {
				this.peerConn.getTransceivers().forEach((transceiver) => {
					const caps = RTCRtpReceiver.getCapabilities('video');
					if (caps) {
						const preferred = caps.codecs.filter(
							(c) => c.mimeType === 'video/VP9' || c.mimeType === 'video/AV1'
						);
						const rest = caps.codecs.filter(
							(c) => c.mimeType !== 'video/VP9' && c.mimeType !== 'video/AV1'
						);
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

	public setInboundQuality(level: NetworkQualityLevel): void {
		if (!this.subscriptionManager) return;
		let layer: string;
		if (level === NetworkQualityLevel.GOOD) {
			layer = 'L3T3';
		} else if (level === NetworkQualityLevel.FAIR) {
			layer = 'L2T2';
		} else if (level === NetworkQualityLevel.POOR) {
			layer = 'L1T1';
		} else {
			return;
		}
		const updated = this.subscriptionManager.subscriptions.map((sub) => ({ ...sub, layer }));
		this.subscriptionManager.updateSubscription(updated);
	}

	public closePeerConnection(): void {
		delete this.subscriptionManager;
		this.peerConn?.close?.();
	}
}
