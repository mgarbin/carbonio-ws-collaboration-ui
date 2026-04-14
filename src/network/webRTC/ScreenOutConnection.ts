/*
 * SPDX-FileCopyrightText: 2023 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PeerConnConfig } from './PeerConnConfig';
import useStore from '../../store/Store';
import { IScreenOutConnection } from '../../types/network/webRTC/webRTC';
import { NetworkQualityLevel, STREAM_TYPE } from '../../types/store/ActiveMeetingTypes';
import { isSvcSupported, SCREEN_SVC_MODE } from '../../utils/SvcUtils';
import { getScreenStream } from '../../utils/UserMediaManager';
import MeetingsApi from '../apis/MeetingsApi';

export default class ScreenOutConnection implements IScreenOutConnection {
	peerConn: RTCPeerConnection | null;

	meetingId: string;

	rtpSender: RTCRtpSender | null;

	private svcEnabled: boolean = false;

	private originalEncodings: RTCRtpEncodingParameters[] | null = null;

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

	private updateLocalStreamTrack(mediaStreamTrack: MediaStream): Promise<MediaStreamTrack> {
		return new Promise((resolve) => {
			const videoTrack: MediaStreamTrack = mediaStreamTrack.getVideoTracks()[0];
			if (this.peerConn) {
				if (this.rtpSender == null) {
					if (isSvcSupported(SCREEN_SVC_MODE)) {
						// Use addTransceiver to set scalabilityMode at track-creation time.
						// L1T2KEY is suitable for screen content: single spatial layer with
						// two temporal layers and periodic key-frames.
						// The cast is required because scalabilityMode is not yet in all
						// TypeScript DOM lib versions.
						const transceiver = this.peerConn.addTransceiver(videoTrack, {
							direction: 'sendonly',
							sendEncodings: [{ scalabilityMode: SCREEN_SVC_MODE } as RTCRtpEncodingParameters],
							streams: [mediaStreamTrack]
						});
						this.rtpSender = transceiver.sender;
						this.svcEnabled = true;
					} else {
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
		this.svcEnabled = false;
		this.originalEncodings = null;
	}

	public async setOutboundQuality(level: NetworkQualityLevel): Promise<void> {
		// When SVC is active the SFU selectively forwards the appropriate temporal
		// layer to each subscriber.  Manipulating the sender's encoding parameters
		// (maxBitrate, scaleResolutionDownBy) would interfere with the SVC stream
		// and is therefore skipped.
		if (this.svcEnabled) return;

		if (!this.rtpSender) return;
		const params = this.rtpSender.getParameters();
		if (!params.encodings || params.encodings.length === 0) {
			params.encodings = [{}];
		}

		if (level === NetworkQualityLevel.GOOD && this.originalEncodings === null) return;

		if (this.originalEncodings === null) {
			this.originalEncodings = params.encodings.map((enc) => ({ ...enc }));
		}

		if (level === NetworkQualityLevel.GOOD) {
			params.encodings = this.originalEncodings.map((enc) => ({ ...enc }));
		} else if (level === NetworkQualityLevel.FAIR) {
			params.encodings = this.originalEncodings.map((enc) => ({
				...enc,
				maxBitrate: 20_000, // bps
				scaleResolutionDownBy: (enc.scaleResolutionDownBy ?? 1) * 2
			}));
		} else if (level === NetworkQualityLevel.POOR) {
			params.encodings = this.originalEncodings.map((enc) => ({
				...enc,
				maxBitrate: 10_000, // bps
				scaleResolutionDownBy: (enc.scaleResolutionDownBy ?? 1) * 5
			}));
		} else {
			return;
		}

		await this.rtpSender.setParameters(params);
	}
}
