package proto

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"gotest.tools/v3/assert"
)

func TestReplyErrorSendsACodedErrorAsItIs(t *testing.T) {
	var buf bytes.Buffer
	coded := &Error{Code: ErrNoSession, Message: `no session "job"`, Data: &ErrorData{BootId: new("boot-7")}}

	err := ReplyError(NewWriter(&buf), fmt.Errorf("attach: %w", coded))

	assert.NilError(t, err)
	f, err := NewReader(&buf).Next()
	assert.NilError(t, err)
	assert.Equal(t, f.Type, TypeResponse)
	var payload any
	assert.NilError(t, json.Unmarshal(f.Payload, &payload))
	assert.DeepEqual(t, payload, map[string]any{"error": map[string]any{
		"code":    "NO_SESSION",
		"message": `no session "job"`,
		"data":    map[string]any{"boot_id": "boot-7"},
	}})
}

func TestReplyErrorSendsAnyOtherErrorAsInternal(t *testing.T) {
	var buf bytes.Buffer

	err := ReplyError(NewWriter(&buf), errors.New("disk on fire"))

	assert.NilError(t, err)
	f, err := NewReader(&buf).Next()
	assert.NilError(t, err)
	assert.Equal(t, f.Type, TypeResponse)
	var payload any
	assert.NilError(t, json.Unmarshal(f.Payload, &payload))
	assert.DeepEqual(t, payload, map[string]any{"error": map[string]any{
		"code":    "INTERNAL",
		"message": "disk on fire",
	}})
}
