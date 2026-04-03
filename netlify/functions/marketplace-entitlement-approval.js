exports.handler = async (event) => {
  return require('./marketplace-account-approval').handler(event);
};
