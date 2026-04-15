/*
 * SPDX-FileCopyrightText: 2023 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PeerConnConfig } from './PeerConnConfig';
import useStore from '../../store/Store';
import { IScreenOutConnection } from '../../types/network/webRTC/webRTC';
import { NetworkQualityLevel, STREAM_TYPE } from '../../types/store/ActiveMeetingTypes';
import { getScreenStream } from '../../utils/UserMediaManager';
import MeetingsApi from '../apis/MeetingsApi';

// VP8 simulcast encodings for screen-share.
// Screen content benefits from higher base bitrate; layers scale 1× / 2× / 4×.
const SCREEN_SIMULCAST_ENCODINGS: RTCRtpEncodingParameters[] = [
	{ rid: 'h', maxBitrate: 1_500_000, scaleResolutionDownBy: 1 },
	{ rid: 'm', maxBitrate: 500_000, scaleResolutionDownBy: 2 },
	{ rid: 'l', maxBitrate: 150_000, scaleResolutionDownBy: 4 }
];

export default class ScreenOutConnection implements IScreenOutConnection {
	peerConn: RTCPeerConnection | null;

	meetingId: string;

	rtpSender: RTCRtpSender | null;

	constructor(meetingId: string) {
		this.peerConn = null;
		this.meetingId = meetingId;
		this.rtpSender = null;
	}

	// Create SDP offer, set it as local description and send it to the remote peer
	private onNegotiationNeeded = (): void => {
		this.peerConn
			?.createOffer()
			.then((rtcSessionDesc: RTCSessionDescriptionInit) => {
				if (this.peerConn?.signalingState === 'stable') {
					this.peerConn
						.setLocalDescription(rtcSessionDesc)
						.then(() => {
							MeetingsApi.updateMediaOffer(
								this.meetingId,
								STREAM_TYPE.SCREEN,
								true,
								rtcSessionDesc.sdp
							);
						})
						.catch((reason) => console.warn(reason));
				}
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

	// Returns true when the browser advertises VP8 codec support, which is required for simulcast.
	private static supportsSimulcast(): boolean {
		try {
			return (
				RTCRtpSender.getCapabilities?.('video')?.codecs.some(
					(c) => c.mimeType === 'video/VP8'
				) === true
			);
		} catch {
			return false;
		}
	}

	private updateLocalStreamTrack(mediaStreamTrack: MediaStream): Promise<MediaStreamTrack> {
		return new Promise((resolve) => {
			const videoTrack: MediaStreamTrack = mediaStreamTrack.getVideoTracks()[0];
			if (this.peerConn) {
				if (this.rtpSender == null) {
					if (ScreenOutConnection.supportsSimulcast()) {
						const transceiver = this.peerConn.addTransceiver(videoTrack, {
							direction: 'sendonly',
							sendEncodings: SCREEN_SIMULCAST_ENCODINGS
						});
						this.rtpSender = transceiver.sender;
					} else {
						// Fallback for environments without VP8 simulcast support
						this.rtpSender = this.peerConn.addTrack(
							videoTrack,
							mediaStreamTrack ?? new MediaStream()
						);
					}
				} else if (this.rtpSender?.track) {
					this.rtpSender.track.stop();
					this.rtpSender.replaceTrack(videoTrack).catch((reason) => console.warn(reason));
				}
			}
			videoTrack.onended = (): void => this.stopScreenShare();
			resolve(videoTrack);
		});
	}

	public startScreenShare(): void {
		this.peerConn = new RTCPeerConnection(new PeerConnConfig().getConfig());
		this.peerConn.onnegotiationneeded = this.onNegotiationNeeded;
		this.peerConn.oniceconnectionstatechange = this.onIceConnectionStateChange;

		getScreenStream().then((stream) => {
			this.updateLocalStreamTrack(stream);
			useStore.getState().setLocalStreams(STREAM_TYPE.SCREEN, stream);
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
						console.warn('Failed to re-apply screen outbound quality after reconnection', err)
					);
				}
			})
			.catch((err) => console.warn('Failed to set screen remote description', err));
	}

	public stopScreenShare(): void {
		this.closePeerConnection();
		MeetingsApi.updateMediaOffer(this.meetingId, STREAM_TYPE.SCREEN, false);
	}

	public closePeerConnection(): void {
		useStore.getState().removeLocalStreams(STREAM_TYPE.SCREEN);
		this.rtpSender?.track?.stop();
		this.peerConn?.close();
		this.peerConn = null;
		this.rtpSender = null;
	}

	// Enable or disable simulcast layers based on available bandwidth.
	// GOOD  → all three layers active (h / m / l)
	// FAIR  → disable the high layer (rid 'h') to reduce bitrate
	// POOR  → keep only the low layer (rid 'l') to minimise bandwidth
	public async setOutboundQuality(level: NetworkQualityLevel): Promise<void> {
		if (!this.rtpSender) return;
		const params = this.rtpSender.getParameters();
		if (!params.encodings || params.encodings.length === 0) return;

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
