// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

'use strict';

var Registry = require('azure-iothub').Registry;
var ConnectionString = require('azure-iothub').ConnectionString;
var deviceSdk = require('azure-iot-device');
var deviceSas = require('azure-iot-device').SharedAccessSignature;
var anHourFromNow = require('azure-iot-common').anHourFromNow;
var uuid = require('uuid');
var _ = require('lodash');
var assert = require('chai').assert;
var async = require('async');
var debug = require('debug')('e2etests:twin_e2e');

var deviceAmqp = require('azure-iot-device-amqp');
var deviceMqtt = require('azure-iot-device-mqtt');

var hubConnectionString = process.env.IOTHUB_CONNECTION_STRING;

var newProps = {
  foo : 1,
  bar : {
    baz : 2,
    tweedle : {
      dee : 3
    }
  }
};

var moreNewProps = {
  bar : {
    baz : 3
  }
};

var mergeResult =  _.merge(JSON.parse(JSON.stringify(newProps)), moreNewProps);

var nullIndividualProps = {
  bar : {
    tweedle: null
  }
};

var nullMergeResult = JSON.parse(JSON.stringify(newProps));
delete nullMergeResult.tweedle;

[
  deviceAmqp.Amqp,
  deviceMqtt.Mqtt
].forEach(function(protocolCtor) {
  describe('Twin over ' + protocolCtor.name, function() {
    this.timeout(60000);
    var deviceClient, deviceTwin;
    var serviceTwin;

    var deviceDescription;

    beforeEach(function (done) {
      var host = ConnectionString.parse(hubConnectionString).HostName;
      var pkey = new Buffer(uuid.v4()).toString('base64');
      var deviceId = '0000e2etest-delete-me-twin-e2e-' + protocolCtor.name + '-'  + uuid.v4();

      deviceDescription = {
        deviceId:  deviceId,
        status: 'enabled',
          authentication: {
          symmetricKey: {
            primaryKey: pkey,
            secondaryKey: new Buffer(uuid.v4()).toString('base64')
          }
        },
        connectionString: 'HostName=' + host + ';DeviceId=' + deviceId + ';SharedAccessKey=' + pkey
      };

      var registry = Registry.fromConnectionString(hubConnectionString);

      registry.create(deviceDescription, function (err) {
        if (err) return done(err);

        var sas = deviceSas.create(host, deviceDescription.deviceId, deviceDescription.authentication.symmetricKey.primaryKey, anHourFromNow()).toString();
        deviceClient = deviceSdk.Client.fromSharedAccessSignature(sas, protocolCtor);

        deviceClient.open(function(err) {
          if (err) return done(err);
          deviceClient.getTwin(function(err, twin) {
            if (err) return done(err);
            deviceTwin = twin;

            registry.getTwin(deviceDescription.deviceId, function(err, twin) {
              if (err) return done(err);
              serviceTwin = twin;
              done();
            });
          });
        });
      });
    });

    afterEach(function (done) {
      if (deviceClient) {
        deviceClient.close(function(err) {
          if (err) return done(err);

          var registry = Registry.fromConnectionString(hubConnectionString);
          registry.delete(deviceDescription.deviceId, function(err) {
            if (err) return done(err);
            done();
          });
        });
      } else {
        done();
      }
    });

    var assertObjectIsEmpty = function(props) {
      _.every(_.keys(props), function(key) {
        if (typeof props[key] !== 'function') {
          assert(key.startsWith('$'), 'key ' + key + ' should not be in empty twin');
        }
      });
    };

    var assertObjectsAreEqual = function(left, right) {
      var compare = function(left, right) {
        _.every(_.keys(right), function(key) {
          if (typeof right[key] !== 'function' && !key.startsWith('$')) {
            assert.equal(left[key], right[key], 'key ' + key + ' not matched between service and device');
          }
        });
      };
      compare(left, right);
      compare(right, left);
    };

    it('relies on $version starting at 1 and incrementing by 1 each time', function(done) {
      assert.equal(deviceTwin.properties.desired.$version,1);
      deviceTwin.on('properties.desired', function() {
        if (deviceTwin.properties.desired.$version === 1) {
          // ignore $update === 1.  assert needed to make jshint happy
          assert(true);
        } else if (deviceTwin.properties.desired.$version === 2) {
          done();
        } else  {
          done(new Error('incorrect property version received - ' + deviceTwin.properties.desired.$version));
        }
      });
      serviceTwin.update( { properties : { desired : newProps } }, function(err) {
        if (err) return done(err);
      });
    });

    var sendsAndReceiveReportedProperties  = function(done) {
      assertObjectIsEmpty(serviceTwin.properties.reported);
      assertObjectIsEmpty(deviceTwin.properties.reported);

      debug('updating reported properties');
      deviceTwin.properties.reported.update(newProps, function(err) {
        if (err) {
          debug('error updating reported properties: ' + err.toString());
          return done(err);
        } else {
          debug('reported properties updated - getting twin from the service side');
          serviceTwin.get(function(err) {
            if (err) {
              debug('error getting twin on the service side');
              return done(err);
            } else {
              debug('got twin from the service side');
              assertObjectsAreEqual(newProps, serviceTwin.properties.reported);
              done();
            }
          });
        }
      });
    };

    it('sends and receives reported properties', sendsAndReceiveReportedProperties);

    var mergeReportedProperties =  function(first, second, result, done) {
      deviceTwin.properties.reported.update(first, function(err) {
        if (err) return done(err);
        deviceTwin.properties.reported.update(second, function(err) {
          if (err) return done(err);
          serviceTwin.get(function(err) {
            if (err) return done(err);
            assertObjectsAreEqual(serviceTwin.properties.reported, result);
            done();
          });
        });
      });
    };

    it('sends and receives merged reported properties', function(done) {
      mergeReportedProperties(newProps, moreNewProps, mergeResult, done);
    });

    var sendsAndReceivesDesiredProperties = function(done) {
      assertObjectIsEmpty(deviceTwin.properties.desired);
      deviceTwin.on('properties.desired', function(props) {
        if (props.$version === 1) {
          debug('initial property update (v1) - ignoring');
        } else if (props.$version === 2) {
          debug('new desired properties update received (v2)');
          assertObjectsAreEqual(newProps, deviceTwin.properties.desired);
          done();
        } else {
          debug('invalid property version! test failure.');
          done(new Error('incorrect property version received - ' + props.$version));
        }
      });

      // wait a little before triggering the properties update to account for subscription time.
      setTimeout(function () {
        debug('sending desired properties update');
        serviceTwin.update( { properties : { desired : newProps } }, function(err) {
          if (err) return done(err);
        });
      }, 3000);
    };

    it('sends and receives desired properties', sendsAndReceivesDesiredProperties);

    var mergeDesiredProperties = function(first, second, newEtag, result, done) {
      deviceTwin.on('properties.desired', function(props) {
        if (props.$version === 1 || props.$version === 2) {
          debug('ignoring initial properties updates with version ' + props.$version);
        } else if (props.$version === 3) {
          debug('property update with $version===3 received');
          assertObjectsAreEqual(deviceTwin.properties.desired, result);
          done();
        } else {
          debug('incorrect property version received: ' + props.$version + ' ; test failure!');
          done(new Error('incorrect property version received - ' + props.$version));
        }
      });

      // account for some delay when subscribing to desired properties updates.
      setTimeout(function () {
        debug('sending first desired properties update');
        serviceTwin.update( { properties : { desired : first } }, function(err) {
          if (err) {
            debug('failed to send the first desired properties update');
            return done(err);
          } else {
            debug('first desired properties update successful');
            if (newEtag) {
              assert.isDefined(serviceTwin.etag);
              assert.notEqual(serviceTwin.etag, "*");
              serviceTwin.etag = newEtag;
            }

            debug('second desired properties updates');
            serviceTwin.update( { properties : { desired : second } }, function(err) {
              if (err) {
                debug('failed to send the second desired properties update.');
                return done(err);
              } else {
                debug('service successfully updated the desired properties');
              }
            });
          }
        });
      }, 3000);
    };

    it('sends and receives merged desired properties', function(done) {
      mergeDesiredProperties(newProps, moreNewProps, null, mergeResult, done);
    });

    it('sends and receives merged desired properties using etag *', function(done) {
      mergeDesiredProperties(newProps, moreNewProps, "*", mergeResult, done);
    });

    it('can get and set tags', function(done) {
      assertObjectIsEmpty(serviceTwin.tags);

      serviceTwin.update( { tags : newProps }, function(err) {
        if (err) return done(err);

        assertObjectsAreEqual(newProps, serviceTwin.tags);
        done();
      });
    });

    var mergeTags =  function(first, second, newEtag, result, done) {
      assertObjectIsEmpty(serviceTwin.tags);

      serviceTwin.update( { tags : first }, function(err) {
        if (err) return done(err);

        if (newEtag) {
          assert.isDefined(serviceTwin.etag);
          assert.notEqual(serviceTwin.etag, "*");
          serviceTwin.etag = newEtag;
        }

        serviceTwin.update( { tags: second }, function(err) {
          if (err) return done(err);
          assertObjectsAreEqual(serviceTwin.tags, result);
          done();
        });
      });
    };

    it('can merge tags', function(done) {
      mergeTags(newProps, moreNewProps, null, mergeResult, done);
    });

    it('can merge tags using etag *', function(done) {
      mergeTags(newProps, moreNewProps, "*", mergeResult, done);
    });

    it('can send reported properties to the service after renewing the sas token', function(done) {
      var newSas = deviceSas.create(ConnectionString.parse(hubConnectionString).HostName, deviceDescription.deviceId, deviceDescription.authentication.symmetricKey.primaryKey, anHourFromNow()).toString();
      debug('updating the shared access signature for device: ' + deviceDescription.deviceId);
      deviceClient.updateSharedAccessSignature(newSas, function (err) {
        if (err) {
          debug('error renewing the shared access signature: ' + err.toString());
          done(err);
        } else {
          debug('updating reported properties');
          sendsAndReceiveReportedProperties(done);
        }
      });
    });

    it('can receive desired properties from the service after renewing the sas token', function(done) {
      var newSas = deviceSas.create(ConnectionString.parse(hubConnectionString).HostName, deviceDescription.deviceId, deviceDescription.authentication.symmetricKey.primaryKey, anHourFromNow()).toString();
      debug('updating the shared access signature for device: ' + deviceDescription.deviceId);
      deviceClient.updateSharedAccessSignature(newSas, function (err) {
        if (err) {
          debug('error renewing the shared access signature: ' + err.toString());
          done(err);
        } else {
          debug('updating desired properties');
          sendsAndReceivesDesiredProperties(done);
        }
      });
    });

    it.skip('call null out all reported properties', function(done) {
      mergeReportedProperties(newProps, null, {}, done);
    });

    it('can null out individual reported properties', function(done) {
      mergeReportedProperties(newProps, nullIndividualProps, nullMergeResult, done);
    });

    it('can null out all desired properties', function(done) {
      mergeDesiredProperties(newProps, null, null, {}, done);
    });

    it('can null out individual desired properties', function(done) {
      mergeDesiredProperties(newProps, nullIndividualProps, null, nullMergeResult, done);
    });

    it('can null out all desired properties with etag *', function(done) {
      mergeDesiredProperties(newProps, null, "*", {}, done);
    });

    it('can null out individual desired properties with etag *', function(done) {
      mergeDesiredProperties(newProps, nullIndividualProps, "*", nullMergeResult, done);
    });

    it('can null out all tags', function(done) {
      mergeTags(newProps, null, null, {}, done);
    });

    it('can null out individual tags', function(done) {
      mergeTags(newProps, nullIndividualProps, null, nullMergeResult, done);
    });

    it('can null out all tags with etag *', function(done) {
      mergeTags(newProps, null, "*", {}, done);
    });

    it('can null out individual tags with etag *', function(done) {
      mergeTags(newProps, nullIndividualProps, "*", nullMergeResult, done);
    });

    it('can renew SAS 20 times without failure', function(done)
    {
      this.timeout(180000);
      var iteration = 0;
      var doItAgain = function() {
        iteration++;
        if (iteration === 20) {
          done();
        } else {
          deviceClient.updateSharedAccessSignature(deviceSas.create(ConnectionString.parse(hubConnectionString).HostName, deviceDescription.deviceId, deviceDescription.authentication.symmetricKey.primaryKey, anHourFromNow()).toString());
          // at this point, signature renewal has begun, but the connection is
          // not complete.  We need a "connection complete" event here, but
          // we don't have one yet.  Instead, sleep for a while -- 3 seconds
          // is good enough for now.
          setTimeout(doItAgain, 3000);
        }
      };

      doItAgain();
    });

    it('can set desired properties while the client is disconnected', function(done) {
      async.series([
        function setDesiredProperties(callback) {
          serviceTwin.update( { properties : { desired : newProps } }, callback);
        },
        function closeDeviceClient(callback) {
          deviceClient.close(callback);
        },
        function setDesiredPropertiesAgain(callback) {
          serviceTwin.update( { properties : { desired : moreNewProps } }, callback);
        },
        function openDeviceClientAgain(callback) {
          deviceClient = deviceSdk.Client.fromConnectionString(deviceDescription.connectionString, protocolCtor);
          deviceClient.open(callback);
        },
        function getDeviceTwin(callback) {
          deviceClient.getTwin(function(err, twin) {
              if (err) return callback(err);
              deviceTwin = twin;
              callback();
          });
        },
        function validateProperties(callback) {
            assertObjectsAreEqual(deviceTwin.properties.desired, mergeResult);
            callback();
        }
      ], done);
    });

    it.skip('can disconnect and reconnect without recreating the transport', function(testCallback) {
      deviceClient.close(function(err) {
        if (err) return testCallback(err);
        deviceClient.open(function(err) {
          if (err) return testCallback(err);
          deviceClient.getTwin(function(err, newTwin) {
            if (err) return testCallback(err);
            assert.strictEqual(newTwin, deviceTwin);
            testCallback();
          });
        });
      });
    });
  });
});
