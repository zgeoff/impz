# Images

Any OCI image can be an imp. impd turns each image into one sparse ext4 file, once per image ID, and
every disk made from it is a clone of that file ([storage](./storage.md)). The guest boots its agent
from a separate system drive, so the image needs nothing of impz in it. The
[images guide](../../guides/images.md) covers adding, building and making images.

## From an OCI image to a disk

1. impd gets the image: a pull for an add, or a BuildKit build of an uploaded context or a host
   directory.
2. It creates a container from the image and exports its filesystem as a tar, then unpacks it on the
   host with owners, modes, file capabilities and user extended attributes, which ext4 keeps.
3. It writes the image's config, its environment, working directory and user, into the tree, where
   the agent reads it as the default for every exec and service.
4. It writes the tree into a sparse ext4 file with room to spare, and puts it in place under the
   image's ID: a hidden directory renamed into place on XFS, or a staging dataset with a base
   snapshot renamed into place on ZFS. A crash during a build leaves only a staging name, which the
   next start removes.

Two names for the same image ID share one file. Each imp records the digest of the file its disk was
cloned from, so an add that points a name at a new digest leaves the lineage of the older imps as it
was. A fork, a backup and a move carry that digest to the imp they make. A backup or a move from an
impd that predates the digest lands the imp with the digest of its image. When a host has no image
at all, impd adds Ubuntu as a default in the background, and the health check reports ready once
that finishes, whether it worked or not.

## Where builds run

A build or a pull runs in a builder imp: a throwaway imp from a builder image, under the `public`
egress policy ([egress](../network/egress.md#public)), which impd destroys when the work ends, and
at start if a stop cut it short. A `RUN` step, a pull and the build frontend's fetch then reach the
internet only, never the host, impd, other imps, the tailnet or private networks. The governor and
the disk budget admit a builder as any imp, and a refusal fails the build rather than fall back to
the host. impd streams the builder's export out of the guest into the same unpack every add uses,
and computes the image's digest itself, so no engine on the host reads what the build made. A
builder is impd's own: every call but a removal is refused it, it never sleeps in the background,
and backups leave it out.

impd fetches the builder image itself, with no Docker engine. oci-fetch, a Go program in imp-host,
reads the image that `IMP_BUILD_IMAGE` names from its registry, picks the host's platform from a
multi-platform index, and writes the image's tree as one tar, with each layer's deletions applied.
impd streams that tar into the same unpack, under the same limits, as a builder's export, and keys
the rootfs by the image's manifest digest. impd passes oci-fetch no other reference, so a client
cannot steer what the host fetches, and no engine on the host builds.

impd checks the build's input on the host before anything runs. It parses the Dockerfile with a port
of the pinned frontend's parser and refuses what the engine would fetch on its own, such as an `ADD`
from a URL or a git remote, a variable in `FROM`, and `ONBUILD`. It pins every image the Dockerfile
names to its registry digest, then builds a rewritten copy of the context with the pinned frontend,
so a Dockerfile cannot choose the frontend BuildKit runs. impd pulls the named images in the builder
first, to pin them. The guard rejects inputs and isolates nothing: the builder is the isolation.

## Template images

A template image is an image made from an imp's disk. impd freezes the guest as for a checkpoint and
clones the disk into a new image directory, named by a UUID that no Docker image ID can be, so impd
never runs Docker for it. Imps are made from it as from any image. Each copy's first boot gets a new
machine-id and new SSH host keys, because every copy would otherwise share the source's. On ZFS the
template is a clone of the source's disk and its imps clones of the template, so any of them can go
in any order, and the reclaim frees blocks once the last user is gone. A backup carries template
images like any image, and a restore of every imp brings back each template too, since one cannot be
pulled again. A boot template is unrelated ([boot templates](../lifecycle/boot-templates.md)).
