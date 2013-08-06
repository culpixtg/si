module.exports = function middlewareConstructor(env) {

  var metrics = require('./metrics')(env),
      utils = require("./utils");

  return {
    /**
     * The operation for the / route is special,
     * and never an edit or remix.
     */
    setNewPageOperation: function(req, res, next) {
      req.body.pageOperation = "create";
      next();
    },

    /**
     * By default, the publish operation is to create a new
     * page. Later functions can override this behaviour.
     */
    setDefaultPublishOperation: function(req, res, next) {
      req.body.pageOperation = "remix";
      next();
    },

    /**
     * Override the default publication operation to act
     * as an update, rather than a create. This will lead
     * to old data being overwritten upon publication.
     */
    setPublishAsUpdate: function(req, res, next) {
      req.body.pageOperation = "edit";
      next();
    },

    /**
     * Check whether the requesting user is authenticated through Persona.
     */
    checkForAuth: function(req, res, next) {
      if (!req.session.email || !req.session.username) {
        return next(new Error("please log in first"));
      }
      next();
    },

    /**
     * Check to see whether a page request is actually for some page.
     */
    requestForId: function(req, res, next) {
      if(!req.params.id) {
        return next(new Error("request did not point to a project"));
      }
      next();
    },

    /**
     * Check to see if a publish attempt actually has data for publishing.
     */
    checkForPublishData: function(req, res, next) {
      if(!req.body.html || req.body.html.trim() === "") {
        return next(new Error("no data to publish"));
      }
      next();
    },

    /**
     * Ensure a publish has metadata. If not default it to an empty object.
     */
    ensureMetaData: function(req, res, next) {
      if(!req.body.metaData) {
        req.body.metaData = {};
      }
      var title = req.body.html.match(/title[^>]*>([^<]*)<\/title/)[1];
      req.body.metaData.title = title;
      req.body.metaData.description = title.replace("My hack of", "An X-Ray Goggles hack of");
      req.body.metaData.author = req.session.username;
      // where should the following value come from?
      req.body.metaData.locale = "";
      next();
    },

    /**
     * Sanitize metadata so that there's no raw HTML in it
     */
    sanitizeMetaData: function(req, res, next) {
      var escapeHTML = function(content) {
            return content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
          },
          metaData = req.body.metaData;
      for(prop in metaData) {
        if(metaData.hasOwnProperty(prop)) {
          metaData[prop] = escapeHTML(metaData[prop]);
        }
      }
      next();
    },

    /**
     * Ensure we're safe to do an edit, if not, force a remix.
     */
    checkPageOperation: function(db) {
      return function(req, res, next) {
        var originalId = req.body.origin;
        // Ensure we are doing an edit on an existing project.
        if (!originalId) {
          return next();
        }

        // Verify that the currently logged in user owns
        // this page, otherwise they might try to update
        // a non-existent page when they hit "publish".
        db.find(originalId, function(err, result) {
          if(err) {
            return next(err);
          }

          // We own this page, so an edit is safe.
          if (req.body.pageOperation === "edit" && result.userid === req.session.email) {
            // We need to know if an edit changed the title,
            // so we can update the old project by the old url.
            if (req.body.metaData.title !== result.title) {
              req.oldUrl = result.url;
            }
            return next();
          }

          // Otherwise, we don't own this page. Go to a remix instead.
          req.body.remixedFrom = result.url;
          req.body.pageOperation = "remix";
          next();
        });
      };
    },

    /**
     * Publish a page to the database. If it's a publish by
     * the owning user, update. Otherwise, insert.
     */
    saveData: function(db, hostName) {
      return function(req, res, next) {
        if (req.body.metaData.title) {
          req.pageTitle = utils.slugify(req.body.metaData.title);
        } else {
          req.pageTitle = "";
        }

        var options = {
          edit: (req.body.pageOperation === "edit"),
          origin: req.body.origin,
          remixedFrom: req.body.remixedFrom,
          rawData: req.body.html,
          sanitizedData: req.body.sanitizedHTML,
          title: req.pageTitle,
          userid: req.session.email
        };

        db.write(options, function(err, result) {
          if (err) {
            metrics.increment('project.save.error');
          } else {
            req.publishId = result.id;
            metrics.increment('project.save.success');
          }
          next(err);
        });
      };
    },

    /**
     * Update the database to store the URL created from S3
     */
    saveUrl: function(db) {
      return function(req, res, next) {
        var options = {
          id: req.publishId,
          userid: req.session.email,
          url: req.publishedUrl
        };
        db.updateUrl(options, function(err) {
          next(err);
        });
      };
    },

    /**
     * Find the make id of the project this was remixed from
     */
    getRemixedFrom: function(db, make) {
      return function(req, res, next) {
        db.find(req.publishId, function(err, result) {
          if (err) {
            return next(err);
          }
          // This means we don't have a remix to worry about
          if (!result.remixedFrom) {
            return next();
          }
          make.search({url: result.remixedFrom}, function(err, makes) {
            if (err) {
              return next(err);
            }
            if (makes.length === 1) {
              req.body.remixedFrom = makes[0]._id;
            }
            next();
          });
        });
      };
    },

    rewritePublishId: function(db) {
      return function(req, res, next) {
        // If the user hasn't defined a title, just use the publishId as-is
        if (!req.pageTitle) {
          req.pageTitle = req.publishId;
          return next();
        }

        // is this an edit or supposed to be a new page?
        var edit = (req.body.pageOperation === "edit");

        db.count({
          userid: req.session.email,
          title: req.pageTitle
        }, function(err, count) {
          if (err) {
            return next(err);
          }

          if (!edit && count > 1) {
            // when it comes to xray goggles publications, multple
            // same-titled makes are fine. We just need to make sure
            // the URL has the count attached.
            req.pageTitleCount = count;
          }

          next();
        });
      };
    },

    generateUrls: function(appName, s3Url, domain) {
      var url = require("url"),
          knox = require("knox"),
          s3 = knox.createClient(s3Url);

      return function(req, res, next) {
        var subdomain = req.session.username,
            suffix = (req.pageTitleCount ? "-" + req.pageTitleCount : ""),
            path = "/" + appName + "/" + req.pageTitle + suffix;

        // Title count suffix, if the title is not unique
        req.publishLocation = "/" + subdomain + path;
        req.s3Url = s3.url(req.publishLocation);

        // Used for make API if USER_SUBDOMAIN exists
        if (domain) {
          domain = url.parse(domain);
          req.customUrl = domain.protocol + "//" + subdomain + "." + domain.host + path;
        }

        next();
      };
    },

    finalizeProject: function(nunjucksEnv, env) {
      var hostname = env.get("HOSTNAME");
      return function(req, res, next) {
        var projectURL = hostname + "/project/" + req.publishId;
        req.body.projectURL = projectURL;
        req.body.finalizedHTML = req.body.sanitizedHTML;
        next();
      };
    },

    /**
     * Publish a page to S3. If it's a publish by
     * the owning user, this effects an update. Otherwise,
     * this will create a new S3 object (=page).
     */
    publishData: function(options) {
      // NOTE: workaround until https://github.com/LearnBoost/knox/issues/194 is addressed.
      //       this line prevents knox from forming url-validation-failing S3 URLs.
      if(!options.port) { delete options.port; }

      var knox = require("knox"),
          s3 = knox.createClient(options);

      return function(req, res, next) {
        var userId = req.session.username,
            data = req.body.finalizedHTML,
            headers = {
              'x-amz-acl': 'public-read',
              'Content-Length': Buffer.byteLength(data,'utf8'),
              'Content-Type': 'text/html;charset=UTF-8'
            };

        // TODO: proper mapping for old->new ids.
        // See: https://bugzilla.mozilla.org/show_bug.cgi?id=862911
        var location = req.publishLocation,
            // FIXME: Plan for S3 being down. This is not the ideal error handling,
            //        but is a working stub in lieu of a proper solution.
            // See: https://bugzilla.mozilla.org/show_bug.cgi?id=865738
            s3PublishError = new Error("There was a problem publishing the page. Your page has been saved"+
                                       " with id "+req.publishId+", so you can edit it, but it could not be"+
                                       " published to the web."),
            s3Error = new Error("failure during publish step (error "+res.statusCode+")");


        // write data to S3
        s3.put(location, headers)
          .on("error", function(err) {
            next(s3PublishError);
          })
          .on("response", function(res) {
            if (res.statusCode === 200) {
              req.publishedUrl = s3.url(location);
              metrics.increment('project.publish.success');
              next();
            } else {
              metrics.increment('project.publish.error');
              next(s3Error);
            }
          })
        .end(data);
      };
    },
    /**
     * Turn the S3 URL into a user subdomain
     */
    rewriteUrl: function(req, res, next) {
      if (req.customUrl) {
        req.publishedUrl = req.customUrl;
      }
      next();
    },

    /**
     * Publish a page to the makeAPI. If it's "our" page,
     * update, otherwise, create.
     */
    publishMake: function(make) {
      return function(req, res, next) {
        var metaData = req.body.metaData,
            options = {
              thumbnail: metaData.thumbnail,
              contentType: "application/x-x-ray-goggles",
              // metadata
              title: metaData.title || "",
              description: metaData.description || "",
              author: metaData.author || "",
              locale: metaData.locale || "",
              email: req.session.email,
              url: req.publishedUrl,
              remixedFrom: req.body.remixedFrom,
              // There is no remixing involved here, you just fire up the goggles again.
              remixUrl: req.publishedUrl,
              tags: metaData.tags ? metaData.tags.split(",") : []
            };

        function finalizePublishMake(err, result) {
          if (err) {
            metrics.increment('makeapi.publish.error');
            next(err);
          } else {
            metrics.increment('makeapi.publish.success');
            next();
          }
        }

        // Publish the make to the makeapi.
        // If it exists and we own it, update it.
        // Otherwise create a new one.
        make.search({
          email: req.session.email,
          url: req.oldUrl || req.publishedUrl
        }, function(err, results) {
          if (err) {
            return finalizePublishMake(err);
          }

          var result = results[0];
          if (result) {
            make.update(result.id, options, finalizePublishMake);
          } else {
            make.create(options, finalizePublishMake);
          }
        });
      };
    },

    /**
     * Unpublish (delete/remove) a project.
     */
    deleteProject: function(databaseAPI) {
      return function(req, res, next) {
        databaseAPI.destroy(req.requestId, function(err, project) {
          if(err) {
            next(err);
          }
          res.json({"status": 200});
        });
      };
    }
  };
};