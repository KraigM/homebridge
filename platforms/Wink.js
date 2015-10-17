var types = require("HAP-NodeJS/accessories/types.js");
var WinkAPI = require('node-winkapi');
var Service = require("hap-nodejs").Service;
var Characteristic = require("hap-nodejs").Characteristic;
var Accessory = require("hap-nodejs").Accessory;
var uuid = require("hap-nodejs").uuid;
var inherits = require('util').inherits;

var model = {
  light_bulbs: require('wink-js/lib/model/light'),
  refreshUntil: function(that, maxTimes, predicate) {
      setTimeout(function() {
        that.refreshData(function() {
          if (predicate != undefined && predicate(that.device) != true && maxTimes > 0) {
            maxTimes = maxTimes - 1;
            model.refreshUntil(that, maxTimes, predicate);
          }
        });
      }, 1000);
    }
};

function WinkPlatform(log, config){

  // auth info
  this.client_id = config["client_id"];
  this.client_secret = config["client_secret"];

  this.api = new WinkAPI.WinkAPI({
    clientID     : this.client_id,
    clientSecret : this.client_secret
  });

  this.username = config["username"];
  this.password = config["password"];

  this.log = log;
}

WinkPlatform.prototype = {
  accessories: function(callback) {
    this.log("Fetching Wink devices.");

    var that = this;
    var foundAccessories = [];

    this.api.login(this.username, this.password, function(err) {
      if (!!err) that.log('login error: ' + err.message);

      that.api.getDevices(function(err, devices) {
        if (!!err) return that.log('getDevices: ' + err.message);

        for (var i = 0; i < devices.length; i++) {
          device = devices[i];
          if (device.type == 'lock') {
            foundAccessories.push(new WinkLockAccessory(that.log, device, that.api));
          } else if (device.type == 'light_bulb') {
            foundAccessories.push(new WinkLightAccessory(that.log, device, that.api));
          }
        }

        callback(foundAccessories);
      });
    }).on('error', function(err) {
      that.log('background error: ' + err.message);
    });
  }
}


function WinkAccessory(log, device, api) {
  // construct base
  this.device = device;
  this.api = api;
  this.name = device.props.name;
  this.log = log;
  var id = uuid.generate('hb:wink:' + this.device.props.type + ':' + this.device.props.lock_id);
  Accessory.call(this, this.name, id);

  // set some basic properties (these values are arbitrary and setting them is optional)
  this
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, this.device.props.device_manufacturer)
      .setCharacteristic(Characteristic.Model, this.device.props.model_name);

  WinkAccessory.prototype.loadData.call(this);
}

inherits(WinkAccessory, Accessory);
WinkAccessory.prototype.parent = Accessory.prototype;

WinkAccessory.prototype.getServices = function() {
  return this.services;
};

WinkAccessory.prototype.loadData = function() {
};

WinkAccessory.prototype.refreshData = function(callback) {
  var that = this;
  this.api.getDevice(this.device, function(err, device) {
    if (!!err) {
      log('getDevice: ' + err.message);
      callback(err);
    } else {
      that.device = device;
      that.loadData();
      if (callback != undefined) {
        callback(err);
      }
    }
  });
};




function WinkLockAccessory(log, device, api) {
  // construct base
  WinkAccessory.call(this, log, device, api);

  // accessor
  var that = this;

  // set some basic properties (these values are arbitrary and setting them is optional)
  this
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.SerialNumber, this.device.props.lock_id);

  // Add the actual Door Lock Service and listen for change events from iOS.
  // We can see the complete list of Services and Characteristics in `lib/gen/HomeKitTypes.js`
  this
      .addService(Service.LockMechanism, this.device.props.name) // services exposed to the user should have "names" like "Fake Light" for us
      .getCharacteristic(Characteristic.LockTargetState)
      .on('get', function(callback) {
        callback(null, that.isLockTarget());
      })
      .on('set', function(value, callback) {
        var locked;
        if (value == Characteristic.LockTargetState.SECURED) {
          locked = true;
        } else if (value == Characteristic.LockTargetState.UNSECURED) {
          locked = false;
        } else {
          callback({"message":"Unsupported"});
          return;
        }

        that.setLockTarget(value);

        that.api.setDevice(device, { "desired_state": { "locked": locked } }, function() {
          model.refreshUntil(that, 5, function() {
            return that.isLocked() != that.isLockTarget();
          });
        });

        callback();
      });

  // We want to intercept requests for our current state so we can query the hardware itself instead of
  // allowing HAP-NodeJS to return the cached Characteristic.value.
  this
      .getService(Service.LockMechanism)
      .getCharacteristic(Characteristic.LockCurrentState)
      .on('get', function(callback) {
        // this event is emitted when you ask Siri directly whether your lock is locked or not. you might query
        // the lock hardware itself to find this out, then call the callback. But if you take longer than a
        // few seconds to respond, Siri will give up.

        that.refreshData(function(err) {
          if (!!err) {
            log('getDevice: ' + err.message);
            callback(err, null);
          }else{
            callback(err, that.isLocked());
          }
        });
      });

  WinkLockAccessory.prototype.loadData.call(this);
}

inherits(WinkLockAccessory, WinkAccessory);
WinkLockAccessory.prototype.parent = WinkAccessory.prototype;

WinkLockAccessory.prototype.loadData = function() {
  this.parent.loadData.call(this);
  this.getService(Service.LockMechanism)
      .setCharacteristic(Characteristic.LockCurrentState, this.isLocked());
};

WinkLockAccessory.prototype.isLockTarget= function() {
  return this.device.props.desired_state.locked  ? Characteristic.LockCurrentState.SECURED : Characteristic.LockCurrentState.UNSECURED;
};

WinkLockAccessory.prototype.setLockTarget= function(value) {
  this.device.props.desired_state.locked = (value == Characteristic.LockCurrentState.SECURED);
};

WinkLockAccessory.prototype.isLocked= function() {
  return this.device.props.last_reading.locked  ? Characteristic.LockCurrentState.SECURED : Characteristic.LockCurrentState.UNSECURED;
};


module.exports.accessory = WinkAccessory;
module.exports.accessory = WinkLockAccessory;
module.exports.accessory = WinkLightAccessory;
module.exports.platform = WinkPlatform;
