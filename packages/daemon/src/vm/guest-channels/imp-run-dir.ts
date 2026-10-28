// Not a security boundary, since the agent dials as the image's user, who owns each forwarded
// agent; it keeps a root image's forward off impd's own sockets.
export const IMP_RUN_DIR = '/run/imp/';
