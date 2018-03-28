#!/bin/bash

# Copyright (c) Microsoft. All rights reserved.
# Licensed under the MIT license. See LICENSE file in the project root for full license information.

cleanup_and_exit()
{
    exit $1
}

pushd "$(dirname "$0")/build_parallel"
if [ ! -d "node_modules" ]; then
    echo ""
    echo "-- Setting up build_parallel tool --"
    npm install
    [ $? -eq 0 ] || cleanup_and_exit $?
fi
popd

node "$(dirname "$0")/build_parallel/build_parallel.js" $*
cleanup_and_exit $?

