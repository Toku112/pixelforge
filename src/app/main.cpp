// Application entry point: creates the Qt application, the engine services, the node types and the main window. The
// window's contents (menus, panels, viewer) arrive with PLAN Part C item 13.

#include "app/Brand.h"
#include "core/graph/NodeDef.h"
#include "engine/Engine.h"
#include "engine/Scheduler.h"
#include "io/Formats.h"
#include "io/ImageReader.h"
#include "nodes/Builtins.h"

#include <QApplication>
#include <QCommandLineOption>
#include <QCommandLineParser>
#include <QCoreApplication>
#include <QMainWindow>
#include <QString>
#include <QTimer>

#include <cstdlib>
#include <exception>
#include <iostream>
#include <memory>
#include <utility>

namespace {

QString toQString(std::string_view text) {
    return QString::fromUtf8(text.data(), static_cast<qsizetype>(text.size()));
}

int run(int argc, char** argv) {
    const QApplication app(argc, argv);
    QApplication::setApplicationName(toQString(pf::APP_NAME));
    QApplication::setApplicationVersion(QStringLiteral(PF_VERSION_STRING));

    QCommandLineParser parser;
    parser.addHelpOption();
    parser.addVersionOption();
    // For the integration tests (tests/integration): start normally, then quit once the event loop runs.
    QCommandLineOption smokeTestOption(QStringLiteral("smoke-test"),
                                       QStringLiteral("Start, show the main window and quit (startup check)."));
    smokeTestOption.setFlags(QCommandLineOption::HiddenFromHelp);
    parser.addOption(smokeTestOption);
    parser.process(app);

    // Background work never waits on this thread (CLAUDE.md §3.5); declaring it lets the engine enforce that.
    pf::engine::setUiThread();
    // Job scheduler, memory budget (60 % of RAM until Preferences > Performance sets it) and tile memory. Destroyed
    // before the application object: running jobs are cancelled and finish first.
    const pf::engine::Engine engine;

    // Image formats the Read node opens and the node types of the graph.
    auto formats = std::make_shared<pf::io::FormatRegistry>();
    pf::io::addBuiltinFormats(*formats);
    pf::graph::NodeRegistry nodeTypes;
    pf::nodes::registerBuiltinNodes(nodeTypes, std::move(formats));

    QMainWindow window;
    window.setWindowTitle(toQString(pf::APP_NAME));
    window.resize(1280, 800);
    window.show();
    if (parser.isSet(smokeTestOption)) {
        QTimer::singleShot(0, [] { QCoreApplication::quit(); });
    }
    return QApplication::exec();
}

} // namespace

// A failure while starting (a node type that does not register, a missing library) ends the app with a message
// instead of an unexplained crash.
int main(int argc, char* argv[]) {
    try {
        return run(argc, argv);
    } catch (const std::exception& error) {
        std::cerr << pf::APP_NAME << " could not start: " << error.what() << '\n';
    } catch (...) {
        std::cerr << pf::APP_NAME << " could not start: unknown error\n";
    }
    return EXIT_FAILURE;
}
