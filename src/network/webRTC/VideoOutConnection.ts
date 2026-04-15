/*
 * SPDX-FileCopyrightText: 2023 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PeerConnConfig } from './PeerConnConfig';
import useStore from '../../store/Store';
import { IVideoOutConnection } from '../../types/network/webRTC/webRTC';
import { NetworkQualityLevel, STREAM_TYPE } from '../../types/store/ActiveMeetingTypes';
import { getVideoStream } from '../../utils/UserMediaManager';
import MeetingsApi from '../apis/MeetingsApi';

// VP8 simulcast encodings sent by the publisher.
// Three spatial layers: full resolution (h), half (m), quarter (l).
const SIMULCAST_ENCODINGS: RTCRtpEncodingParameters[] = [
	{ rid: 'h', maxBitrate: 900_000, scaleResolutionDownBy: 1 },
	{ rid: 'm', maxBitrate: 300_000, scaleResolutionDownBy: 2 },
	{ rid: 'l', maxBitrate: 75_000, scaleResolutionDownBy: 4 }
];

export default class VideoOutConnection implements IVideoOutConnection {
	peerConn: RTCPeerConnection | null;

	meetingId: string;

	rtpSender: RTCRtpSender | null;

	selectedVideoDeviceId: string | undefined;

	constructor(meetingId: string, videoStreamEnabled: boolean, selectedVideoDeviceId?: string) {
		this.peerConn = null;
		this.meetingId = meetingId;
		this.rtpSender = null;

		if (videoStreamEnabled) {
			this.startVideo(selectedVideoDeviceId);
		}
	}

	public startVideo(selectedVideoDeviceId?: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this.peerConn = new RTCPeerConnection(new PeerConnConfig().getConfig());
			this.peerConn.onnegotiationneeded = this.onNegotiationNeeded;
			this.peerConn.oniceconnectionstatechange = this.onIceConnectionStateChange;

			if (selectedVideoDeviceId) this.selectedVideoDeviceId = selectedVideoDeviceId;

			getVideoStream(selectedVideoDeviceId)
				.then((stream) => {
					this.updateLocalStreamTrack(stream);
					useStore.getState().setLocalStreams(STREAM_TYPE.VIDEO, stream);
					resolve();
				})
				.catch((err) => {
					reject(new Error(`Error while requesting video track, reason: ${err}`));
				});
		});
	}

	public stopVideo(): void {
		this.closePeerConnection();
		MeetingsApi.updateMediaOffer(this.meetingId, STREAM_TYPE.VIDEO, false);
	}

	// Create SDP offer, set it as local description and send it to the remote peer
	private onNegotiationNeeded = (): void => {
		this.peerConn
			?.createOffer()
			.then((rtcSessionDesc: RTCSessionDescriptionInit) => {
				this.peerConn
					?.setLocalDescription(rtcSessionDesc)
					.then(() => {
						MeetingsApi.updateMediaOffer(
							this.meetingId,
							STREAM_TYPE.VIDEO,
							true,
							rtcSessionDesc.sdp
						);
					})
					.catch((reason) => console.warn(reason));
			})
			.catch((reason) => console.warn('createOffer failed', reason));
	};

	private onIceConnectionStateChange = (ev: Event): void => {
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		if (ev.target.iceConnectionState === 'failed') {
			this.onNegotiationNeeded();
		}
	};

	// Add a simulcast transceiver for the initial track, or replace the track on an existing sender.
	public updateLocalStreamTrack(
		mediaStreamTrack: MediaStream,
		isVirtualBackground?: boolean
	): Promise<MediaStreamTrack> {
		return new Promise((resolve) => {
			const videoTrack: MediaStreamTrack = mediaStreamTrack.getVideoTracks()[0];
			if (this.peerConn) {
				if (this.rtpSender == null) {
					const transceiver = this.peerConn.addTransceiver(videoTrack, {
						direction: 'sendonly',
						sendEncodings: SIMULCAST_ENCODINGS
					});
					this.rtpSender = transceiver.sender;
				} else if (this.rtpSender?.track) {
					if (isVirtualBackground) {
						this.rtpSender.replaceTrack(videoTrack).catch((reason) => console.warn(reason));
					} else {
						this.rtpSender.track.stop();
						this.rtpSender.replaceTrack(videoTrack).catch((reason) => console.warn(reason));
					}
				}
			}
			resolve(videoTrack);
		});
	}

	// Handle remote answer to the SDP offer arrived from the signaling channel
	public handleRemoteAnswer(remoteAnswer: RTCSessionDescriptionInit): void {
		const remoteDescription: RTCSessionDescription = new RTCSessionDescription(remoteAnswer);
		this.peerConn
			?.setRemoteDescription(remoteDescription)
			.then(() => {
				const quality = useStore.getState().activeMeeting?.networkStats?.quality;
				if (quality && quality !== NetworkQualityLevel.UNKNOWN) {
					this.setOutboundQuality(quality).catch((err) =>
						console.warn('Failed to re-apply video outbound quality after reconnection', err)
					);
				}
			})
			.catch((err) => console.warn('Failed to set video remote description', err));
	}

	public closePeerConnection(): void {
		useStore.getState().removeLocalStreams(STREAM_TYPE.VIDEO);
		useStore.getState().removeBackgroundStream();
		this.rtpSender?.track?.stop();
		this.peerConn?.close();
		this.rtpSender = null;
		this.peerConn = null;
	}

	// Enable or disable simulcast layers based on available bandwidth.
	// GOOD  → all three layers active (h / m / l)
	// FAIR  → disable the high layer (rid 'h') to reduce bitrate
	// POOR  → keep only the low layer (rid 'l') to minimise bandwidth
	public async setOutboundQuality(level: NetworkQualityLevel): Promise<void> {
		if (!this.rtpSender) return;
		const params = this.rtpSender.getParameters();
		if (!params.encodings || params.encodings.length === 0) {
			console.warn('VideoOutConnection.setOutboundQuality: no encodings available');
			return;
		}

		if (level === NetworkQualityLevel.GOOD) {
			params.encodings = params.encodings.map((enc) => ({ ...enc, active: true }));
		} else if (level === NetworkQualityLevel.FAIR) {
			params.encodings = params.encodings.map((enc) => ({ ...enc, active: enc.rid !== 'h' }));
		} else if (level === NetworkQualityLevel.POOR) {
			params.encodings = params.encodings.map((enc) => ({ ...enc, active: enc.rid === 'l' }));
		} else {
			return;
		}

		await this.rtpSender.setParameters(params);
	}
}
