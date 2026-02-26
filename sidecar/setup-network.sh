#!/usr/bin/env bash
set -euo pipefail

NETWORK_NAME="${CONTAINER_NETWORK:-agent-sandbox}"

# Create the bridge network if it doesn't exist
if ! docker network inspect "$NETWORK_NAME" &>/dev/null; then
    echo "Creating Docker network: $NETWORK_NAME"
    docker network create \
        --driver bridge \
        --internal=false \
        "$NETWORK_NAME"
    echo "Network $NETWORK_NAME created."
else
    echo "Network $NETWORK_NAME already exists."
fi

echo ""
echo "To block internal network access from containers, add iptables rules:"
echo "  iptables -I DOCKER-USER -s 172.18.0.0/16 -d 10.0.0.0/8 -j DROP"
echo "  iptables -I DOCKER-USER -s 172.18.0.0/16 -d 172.16.0.0/12 -j DROP"
echo "  iptables -I DOCKER-USER -s 172.18.0.0/16 -d 192.168.0.0/16 -j DROP"
echo "  iptables -I DOCKER-USER -s 172.18.0.0/16 -d 169.254.0.0/16 -j DROP"
echo ""
echo "Note: Allow the Bifrost gateway address explicitly before applying these rules."
