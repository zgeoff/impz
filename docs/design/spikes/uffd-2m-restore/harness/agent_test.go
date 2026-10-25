package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"testing"
	"time"

	"gotest.tools/v3/assert"
)

// startStubVsock answers each connection as Firecracker's vsock socket and
// a guest agent would: the handshake line, then one response frame per
// request, from the answers in order.
func startStubVsock(t *testing.T, handshake string, answers ...string) (string, chan []byte) {
	t.Helper()
	t.Chdir(t.TempDir())
	listener, err := net.Listen("unix", "vsock.sock")
	assert.NilError(t, err)
	t.Cleanup(func() { listener.Close() })
	requests := make(chan []byte, len(answers))
	go func() {
		for _, answer := range answers {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			reader := bufio.NewReader(conn)
			if _, err := reader.ReadString('\n'); err != nil {
				conn.Close()
				return
			}
			_, _ = conn.Write([]byte(handshake))
			_, payload, err := readFrame(reader)
			if err == nil {
				requests <- payload
				_, _ = conn.Write(encodeFrame(frameResponse, []byte(answer)))
			}
			conn.Close()
		}
	}()
	return "vsock.sock", requests
}

func TestReadFrameReadsWhatEncodeFrameWrote(t *testing.T) {
	frameType, payload, err := readFrame(bytes.NewReader(encodeFrame(frameRequest, []byte(`{"op":"ping"}`))))

	assert.NilError(t, err)
	assert.Equal(t, frameType, byte(frameRequest))
	assert.Equal(t, string(payload), `{"op":"ping"}`)
}

func TestReadFrameRefusesAPayloadOverTheLimit(t *testing.T) {
	header := []byte{frameResponse, 0x00, 0x10, 0x00, 0x01}

	_, _, err := readFrame(bytes.NewReader(header))

	assert.Error(t, err, "agent frame too large: 1048577 bytes")
}

func TestSendClaimSendsTheClaimAsProtoJSON(t *testing.T) {
	socket, requests := startStubVsock(t, "OK 1073741824\n", `{"ok":true}`)

	err := sendClaim(socket, claim{
		ID: "c0ffee00-0000-4000-8000-000000000001", Hostname: "pebble", IP: "10.9.0.2/30", GW: "10.9.0.1",
		DNS: []string{"10.9.0.53"}, MAC: "06:00:0a:09:00:02", DiskBytes: 4096, UnixMs: 1700000000000, Seed: []byte{1, 2, 3},
	})
	var sent map[string]any
	assert.NilError(t, json.Unmarshal(<-requests, &sent))

	assert.NilError(t, err)
	assert.DeepEqual(t, sent, map[string]any{"op": "claim", "claim": map[string]any{
		"id": "c0ffee00-0000-4000-8000-000000000001", "hostname": "pebble", "ip": "10.9.0.2/30", "gw": "10.9.0.1",
		"dns": []any{"10.9.0.53"}, "mac": "06:00:0a:09:00:02", "disk_bytes": 4096.0, "unix_ms": 1700000000000.0, "seed": "AQID",
	}})
}

func TestSendAgentRequestRefusesAFailedHandshake(t *testing.T) {
	socket, _ := startStubVsock(t, "FAILURE\n", `{"ok":true}`)

	_, err := sendAgentRequest(socket, map[string]any{"op": "ping"}, time.Second)

	assert.Error(t, err, `vsock handshake refused: "FAILURE\n"`)
}

func TestWaitForAgentWaitsUntilTheAgentLeavesTheTemplate(t *testing.T) {
	socket, _ := startStubVsock(t, "OK 1\n",
		`{"ok":true,"version":"0.21.0","stage":"template"}`,
		`{"ok":true,"version":"0.21.0","boot_steps":[{"name":"claim","ms":4},{"name":"mount","ms":38}]}`,
	)

	answer, err := waitForAgent(socket, waitOptions{deadline: 5 * time.Second, attempt: time.Second, maxDelay: 5 * time.Millisecond})

	assert.NilError(t, err)
	assert.DeepEqual(t, answer.BootSteps, []bootStep{{Name: "claim", Ms: 4}, {Name: "mount", Ms: 38}})
}
