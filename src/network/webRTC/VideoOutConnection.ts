/*
 * SPDX-FileCopyrightText: 2023 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PeerConnConfig } from './PeerConnConfig';
import useStore from '../../store/Store';
import { IVideoOutConnection } from '../../types/network/webRTC/webRTC';
import { STREAM_TYPE } from '../../types/store/ActiveMeetingTypes';
import { getVideoStream } from '../../utils/UserMediaManager';
import MeetingsApi from '../apis/MeetingsApi';

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
		// Mute the outgoing track without tearing down the peer connection.
		// Keeping the connection alive avoids a full ICE/DTLS renegotiation on the
		// next startVideo() call, which fixes a grey-screen bug on Firefox caused by
		// renegotiation emitting ontrack events with an empty ev.streams array.
		if (this.rtpSender) {
			this.rtpSender.replaceTrack(null).catch((reason) => console.warn(reason));
		}
		useStore.getState().removeLocalStreams(STREAM_TYPE.VIDEO);
		useStore.getState().removeBackgroundStream();
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

	// Replace the outgoing video track without triggering a new SDP negotiation.
	public updateLocalStreamTrack(
		mediaStreamTrack: MediaStream,
		isVirtualBackground?: boolean
	): Promise<MediaStreamTrack> {
		return new Promise((resolve) => {
			const videoTrack: MediaStreamTrack = mediaStreamTrack.getVideoTracks()[0];
			if (this.peerConn) {
				if (this.rtpSender == null) {
					this.rtpSender = this.peerConn?.addTrack(
						videoTrack,
						mediaStreamTrack ?? new MediaStream()
					);
				} else {
					// replaceTrack works whether the current sender track is active or null
					// (null occurs after stopVideo() muted the sender with replaceTrack(null)).
					// Calling track.stop() before replaceTrack() is not needed and can cause
					// a race condition in Firefox that leaves the remote side with a grey screen.
					this.rtpSender.replaceTrack(videoTrack).catch((reason) => console.warn(reason));
				}
			}
			resolve(videoTrack);
		});
	}

	// Handle remote answer to the SDP offer arrived from the signaling channel
	public handleRemoteAnswer(remoteAnswer: RTCSessionDescriptionInit): void {
		const remoteDescription: RTCSessionDescription = new RTCSessionDescription(remoteAnswer);
		this.peerConn?.setRemoteDescription(remoteDescription);
	}

	public closePeerConnection(): void {
		useStore.getState().removeLocalStreams(STREAM_TYPE.VIDEO);
		useStore.getState().removeBackgroundStream();
		this.rtpSender?.track?.stop();
		this.peerConn?.close();
		this.rtpSender = null;
		this.peerConn = null;
	}
}
