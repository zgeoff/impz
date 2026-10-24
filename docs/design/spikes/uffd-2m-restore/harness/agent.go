package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// The agent's vsock protocol (docs/reference/agent-protocol.md): a
// `[u8 type][u32 BE length][payload]` frame of proto3 JSON, one request per
// connection, through Firecracker's `CONNECT <port>` handshake.
const (
	agentPort     = 1024
	frameRequest  = 1
	frameResponse = 2
	maxPayload    = 1 << 20
)

type bootStep struct {
	Name string  `json:"name"`
	Ms   float64 `json:"ms"`
}

type ping struct {
	OK        bool       `json:"ok"`
	Version   string     `json:"version"`
	UptimeMs  *float64   `json:"uptime_ms"`
	Stage     string     `json:"stage"`
	BootSteps []bootStep `json:"boot_steps"`
	Error     string     `json:"error"`
}

func encodeFrame(frameType byte, payload []byte) []byte {
	out := make([]byte, 5+len(payload))
	out[0] = frameType
	binary.BigEndian.PutUint32(out[1:5], uint32(len(payload)))
	copy(out[5:], payload)
	return out
}

func readFrame(r io.Reader) (byte, []byte, error) {
	var header [5]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return 0, nil, err
	}
	length := binary.BigEndian.Uint32(header[1:5])
	if length > maxPayload {
		return 0, nil, fmt.Errorf("agent frame too large: %d bytes", length)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	return header[0], payload, nil
}

func sendAgentRequest(vsockPath string, request any, timeout time.Duration) (ping, error) {
	var answer ping
	conn, err := net.DialTimeout("unix", vsockPath, timeout)
	if err != nil {
		return answer, err
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return answer, err
	}

	if _, err := fmt.Fprintf(conn, "CONNECT %d\n", agentPort); err != nil {
		return answer, err
	}
	reader := bufio.NewReader(conn)
	line, err := reader.ReadString('\n')
	if err != nil {
		return answer, fmt.Errorf("vsock handshake: %w", err)
	}
	if !strings.HasPrefix(line, "OK ") {
		return answer, fmt.Errorf("vsock handshake refused: %q", line)
	}

	body, err := json.Marshal(request)
	if err != nil {
		return answer, err
	}
	if _, err := conn.Write(encodeFrame(frameRequest, body)); err != nil {
		return answer, err
	}
	frameType, payload, err := readFrame(reader)
	if err != nil {
		return answer, err
	}
	if frameType != frameResponse {
		return answer, fmt.Errorf("agent answered with frame type %d", frameType)
	}
	if err := json.Unmarshal(payload, &answer); err != nil {
		return answer, err
	}
	if !answer.OK {
		return answer, fmt.Errorf("agent refused %v: %s", request, payload)
	}
	return answer, nil
}

type claim struct {
	ID        string   `json:"id"`
	Hostname  string   `json:"hostname"`
	IP        string   `json:"ip"`
	GW        string   `json:"gw"`
	DNS       []string `json:"dns"`
	MAC       string   `json:"mac"`
	DiskBytes float64  `json:"disk_bytes"`
	UnixMs    float64  `json:"unix_ms"`
	Seed      []byte   `json:"seed"`
}

func sendClaim(vsockPath string, c claim) error {
	_, err := sendAgentRequest(vsockPath, map[string]any{"op": "claim", "claim": c}, 2*time.Second)
	return err
}

type waitOptions struct {
	deadline time.Duration
	attempt  time.Duration
	maxDelay time.Duration
	parked   bool
}

// waitForAgent pings as impd's waitForAgent does: from 5 ms between
// attempts, doubling up to maxDelay, until the agent's stage matches.
func waitForAgent(vsockPath string, options waitOptions) (ping, error) {
	deadline := time.Now().Add(options.deadline)
	delay := 5 * time.Millisecond
	lastErr := errors.New("no attempt")
	for time.Now().Before(deadline) {
		answer, err := sendAgentRequest(vsockPath, map[string]any{"op": "ping"}, options.attempt)
		switch {
		case err != nil:
			lastErr = err
		case (answer.Stage == "template") == options.parked:
			return answer, nil
		default:
			lastErr = fmt.Errorf("agent stage %q", answer.Stage)
		}
		time.Sleep(delay)
		delay = min(options.maxDelay, delay*2)
	}
	return ping{}, fmt.Errorf("agent did not answer within %v (last error: %w)", options.deadline, lastErr)
}
