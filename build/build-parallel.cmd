@REM Copyright (c) Microsoft. All rights reserved.
@REM Licensed under the MIT license. See LICENSE file in the project root for full license information.

@setlocal
@echo off

pushd %~dp0%\build_parallel
if not exist node_modules (
    echo.
    echo -- Setting up build_parallel tool --
    call npm install
    if errorlevel 1 goto :cleanup
)
popd

node  %~dp0\build_parallel\build_parallel.js %*

:cleanup
exit /b %ERRORLEVEL%
